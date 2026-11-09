#![no_std]
#![no_main]

mod button;
mod find_led;
mod time_driver;
mod voltage;

use atag::{
    AdvertisementKey, BleAdvertisement, Checkpoint, PROVISIONING_WIRE_LEN, ProvisioningConfig,
    ProvisioningError, RollingKeyGenerator, encode_voltage_status,
};
use atag_firmware_nrf52832::{
    device_name::{DeviceName, MAX_NAME_BYTES},
    journal::CheckpointJournal,
    led::{HARDWARE_ADDRESS, Hardware},
    ota::{self, OtaError, OtaSession},
    provisioning_store::{DeviceProfile, ProvisioningStore},
    settings::{SETTINGS_WIRE_LEN, Settings},
    telemetry::{BatteryState, PowerReading, TELEMETRY_LEN, Telemetry},
};
use core::{
    cell::Cell,
    pin::pin,
    ptr,
    sync::atomic::{AtomicBool, AtomicU32, Ordering},
};
use cortex_m_rt::entry;
use embassy_executor::raw::Executor;
use embassy_futures::select::{Either, Either3, select, select3};
use embassy_nrf::{
    config::LfclkSource,
    gpio::{Input, Pull},
    interrupt::Priority,
};
use embassy_sync::{blocking_mutex::raw::CriticalSectionRawMutex, signal::Signal};
use embassy_time::{Duration, Instant, Timer};
use nrf_softdevice::{
    Flash, Softdevice,
    ble::{
        self, Address, AddressType, Connection, Phy, SecurityMode, TxPower, gatt_server,
        peripheral, security::SecurityHandler,
    },
    raw,
};
use panic_halt as _;
use sha2::{Digest, Sha256};
use static_cell::StaticCell;

// DC/DC mode requires a verified external inductor circuit on the target.
const DCDC_ENABLED: bool = false;
const STATUS_SETUP: [u8; 8] = [1, 0, 0, 0, PROVISIONING_WIRE_LEN as u8, 0, 0, 0];
const GATT_ADVERTISING_DATA: &[u8] = &[
    0x02, 0x01, 0x06, 0x11, 0x07, 0xb7, 0x6d, 0x6e, 0x0a, 0x8b, 0xa3, 0x22, 0x9c, 0x04, 0x4f, 0x5b,
    0x9b, 0x00, 0x00, 0x4a, 0x0f,
];

static EXECUTOR: StaticCell<Executor> = StaticCell::new();
static EXECUTOR_PENDING: AtomicBool = AtomicBool::new(true);
static GATT_SERVER: StaticCell<GattServer> = StaticCell::new();
static BUTTON_EVENTS: Signal<CriticalSectionRawMutex, ButtonEvent> = Signal::new();
static BUTTON_HELD: AtomicBool = AtomicBool::new(false);
static BUTTON_PRESS_COUNT: AtomicU32 = AtomicU32::new(0);
static SESSION_SECURITY: SessionSecurity = SessionSecurity;
static RESET_HOLD_SECONDS: AtomicU32 = AtomicU32::new(5);
static APPLICATION_HEALTHY: AtomicBool = AtomicBool::new(false);
const OTA_PUBLIC_KEY: &[u8; 32] = include_bytes!("../ota-public-key.bin");

/// Raw, variable-length bytes; validation is performed before committing.
#[derive(Clone, Copy)]
struct GattName {
    bytes: [u8; MAX_NAME_BYTES],
    len: usize,
}
impl ble::GattValue for GattName {
    const MIN_SIZE: usize = 0;
    const MAX_SIZE: usize = MAX_NAME_BYTES;
    fn from_gatt(data: &[u8]) -> Self {
        assert!(data.len() <= MAX_NAME_BYTES);
        let mut value = Self {
            bytes: [0; MAX_NAME_BYTES],
            len: data.len(),
        };
        value.bytes[..data.len()].copy_from_slice(data);
        value
    }
    fn to_gatt(&self) -> &[u8] {
        &self.bytes[..self.len]
    }
}
impl From<DeviceName> for GattName {
    fn from(value: DeviceName) -> Self {
        <Self as ble::GattValue>::from_gatt(value.as_bytes())
    }
}

#[derive(Clone, Copy)]
struct GattOtaData {
    bytes: [u8; ota::DATA_LEN],
    len: usize,
}
impl ble::GattValue for GattOtaData {
    const MIN_SIZE: usize = 0;
    const MAX_SIZE: usize = ota::DATA_LEN;
    fn from_gatt(data: &[u8]) -> Self {
        let mut value = Self {
            bytes: [0; ota::DATA_LEN],
            len: data.len(),
        };
        value.bytes[..data.len()].copy_from_slice(data);
        value
    }
    fn to_gatt(&self) -> &[u8] {
        &self.bytes[..self.len]
    }
}

// SWD-readable state: 1=boot, 2=GATT advertising, 3=connected, 4=fixed,
// 5=rotating, 6=factory-reset commit, 7=unconfigured idle.
#[unsafe(no_mangle)]
#[used]
static FIRMWARE_STATUS: AtomicU32 = AtomicU32::new(0);
#[unsafe(no_mangle)]
#[used]
static SUPPLY_MILLIVOLTS: AtomicU32 = AtomicU32::new(0);
#[unsafe(no_mangle)]
#[used]
static BATTERY_MILLIVOLTS: AtomicU32 = AtomicU32::new(0);
#[unsafe(no_mangle)]
#[used]
static BATTERY_RAW_SAMPLE: AtomicU32 = AtomicU32::new(0);
#[unsafe(no_mangle)]
#[used]
static CURRENT_ROTATION: AtomicU32 = AtomicU32::new(0);
#[unsafe(no_mangle)]
#[used]
static LAST_BLE_ERROR: AtomicU32 = AtomicU32::new(0);

struct SessionSecurity;
// Just Works pairing without persistent bonding. The physical button limits
// the exposure window, and protected attributes trigger session encryption.
impl SecurityHandler for SessionSecurity {}

#[derive(Clone, Copy)]
enum ButtonEvent {
    Pressed,
    LongHold,
}
#[derive(Clone, Copy)]
enum WindowResult {
    Closed,
    Reboot,
    FactoryReset,
}

#[nrf_softdevice::gatt_service(uuid = "0f4a0000-9b5b-4f04-9c22-a38b0a6e6db7")]
struct ProvisioningService {
    #[characteristic(
        uuid = "0f4a0001-9b5b-4f04-9c22-a38b0a6e6db7",
        write,
        security = "justworks"
    )]
    config: [u8; PROVISIONING_WIRE_LEN],
    #[characteristic(uuid = "0f4a0002-9b5b-4f04-9c22-a38b0a6e6db7", read, notify)]
    status: [u8; 8],
    #[characteristic(
        uuid = "0f4a0003-9b5b-4f04-9c22-a38b0a6e6db7",
        read,
        notify,
        security = "justworks"
    )]
    information: [u8; TELEMETRY_LEN],
    #[characteristic(uuid = "0f4a0004-9b5b-4f04-9c22-a38b0a6e6db7", read, notify)]
    battery_mv: u16,
    // 1=software reboot, 2=factory reset. Both require an encrypted session.
    #[characteristic(
        uuid = "0f4a0005-9b5b-4f04-9c22-a38b0a6e6db7",
        write,
        security = "justworks"
    )]
    control: u8,
    #[characteristic(
        uuid = "0f4a0006-9b5b-4f04-9c22-a38b0a6e6db7",
        read,
        write,
        security = "justworks"
    )]
    name: GattName,
    #[characteristic(
        uuid = "0f4a0007-9b5b-4f04-9c22-a38b0a6e6db7",
        read,
        write,
        security = "justworks"
    )]
    settings: [u8; SETTINGS_WIRE_LEN],
    #[characteristic(uuid = "0f4a0008-9b5b-4f04-9c22-a38b0a6e6db7", read, notify)]
    button_events: u32,
    // Write 1 to request Just Works pairing before sending protected ATT reads.
    #[characteristic(uuid = "0f4a0009-9b5b-4f04-9c22-a38b0a6e6db7", read, write, notify)]
    pairing: u8,
    #[characteristic(uuid = "0f4a000a-9b5b-4f04-9c22-a38b0a6e6db7", write)]
    ota_control: [u8; ota::CONTROL_LEN],
    #[characteristic(uuid = "0f4a000b-9b5b-4f04-9c22-a38b0a6e6db7", write)]
    ota_data: GattOtaData,
    #[characteristic(uuid = "0f4a000c-9b5b-4f04-9c22-a38b0a6e6db7", read, notify)]
    ota_status: [u8; ota::STATUS_LEN],
    #[characteristic(uuid = "0f4a000d-9b5b-4f04-9c22-a38b0a6e6db7", read)]
    profile_snapshot: [u8; 40],
}

#[nrf_softdevice::gatt_service(uuid = "180a")]
struct DeviceInformationService {
    #[characteristic(uuid = "2a29", read)]
    manufacturer: [u8; 4],
    #[characteristic(uuid = "2a24", read)]
    model: [u8; 8],
    #[characteristic(uuid = "2a26", read)]
    firmware: [u8; 5],
    #[characteristic(uuid = "2a25", read)]
    serial: [u8; 16],
}

#[nrf_softdevice::gatt_server]
struct GattServer {
    provisioning: ProvisioningService,
    device: DeviceInformationService,
}

#[unsafe(export_name = "__pender")]
fn pender(_context: *mut ()) {
    EXECUTOR_PENDING.store(true, Ordering::Release);
    cortex_m::asm::sev();
}

#[entry]
fn main() -> ! {
    // One-shot local debugger/installer request, retained across reset.
    let force_gatt = read_register(0x4000051c) == 0xa4;
    if force_gatt {
        write_register(0x4000051c, 0);
    }
    let mut hal = embassy_nrf::config::Config::default();
    hal.lfclk_source = LfclkSource::ExternalXtal;
    hal.dcdc.reg1 = DCDC_ENABLED;
    // embassy-nrf defaults to enabling RESET_PIN=P0.21 in BOTH UICR.PSELRESET
    // words and resets once if programming an erased UICR. Do not enable its
    // reset-pin-as-gpio feature, and never instantiate P0.21 as a GPIO here.
    let peripherals = embassy_nrf::init(hal);
    time_driver::init(Priority::P2);
    button::init(Priority::P2);
    let button = button::EventButton::new(Input::new(peripherals.P0_13, Pull::Up));
    let mut descriptor = [0; 8];
    descriptor[..4].copy_from_slice(&read_register(HARDWARE_ADDRESS as usize).to_le_bytes());
    descriptor[4..].copy_from_slice(&read_register(HARDWARE_ADDRESS as usize + 4).to_le_bytes());
    let led = find_led::Led::new(peripherals.P0_30, Hardware::decode(&descriptor));
    let reset_reason = read_register(0x4000_0400);
    write_register(0x4000_0400, reset_reason);
    let id = device_id();
    FIRMWARE_STATUS.store(1, Ordering::Release);
    let sd = Softdevice::enable(&softdevice_config());
    // SAFETY: S112 owns POWER while enabled.
    let result = unsafe {
        raw::sd_power_dcdc_mode_set(if DCDC_ENABLED {
            raw::NRF_POWER_DCDC_MODES_NRF_POWER_DCDC_ENABLE as u8
        } else {
            raw::NRF_POWER_DCDC_MODES_NRF_POWER_DCDC_DISABLE as u8
        })
    };
    assert_eq!(result, raw::NRF_SUCCESS);
    let server = GATT_SERVER.init(GattServer::new(sd).expect("register GATT services"));
    server.provisioning.status_set(&STATUS_SETUP).unwrap();
    server.device.manufacturer_set(b"ATAG").unwrap();
    server.device.model_set(b"nRF52832").unwrap();
    server
        .device
        .firmware_set(env!("ATAG_FIRMWARE_VERSION").as_bytes().try_into().unwrap())
        .unwrap();
    server.device.serial_set(&serial_string(id)).unwrap();
    let flash = Flash::take(sd);
    let voltage = voltage::VoltageMonitor::new(peripherals.SAADC, peripherals.P0_28, Priority::P2);
    let executor = EXECUTOR.init(Executor::new(ptr::null_mut()));
    let spawner = executor.spawner();
    spawner.spawn(softdevice_task(sd).unwrap());
    spawner.spawn(button_task(button).unwrap());
    spawner.spawn(watchdog_task().unwrap());
    spawner.spawn(
        firmware_task(
            sd,
            server,
            flash,
            voltage,
            id,
            reset_reason,
            force_gatt,
            led,
        )
        .unwrap(),
    );
    loop {
        EXECUTOR_PENDING.store(false, Ordering::Release);
        // SAFETY: this is the sole executor poll site, and tasks live forever.
        unsafe { executor.poll() };
        if !EXECUTOR_PENDING.swap(false, Ordering::AcqRel) {
            // SAFETY: S112 is enabled and coordinates sleep with its radio.
            let _ = unsafe { raw::sd_app_evt_wait() };
        }
    }
}

#[embassy_executor::task]
async fn softdevice_task(sd: &'static Softdevice) {
    sd.run().await;
}

#[embassy_executor::task]
async fn watchdog_task() {
    loop {
        if APPLICATION_HEALTHY.load(Ordering::Acquire) && read_register(0x40010400) != 0 {
            // WDT is started by the OTA bootloader with reload register 0 enabled.
            write_register(0x40010600, 0x6e524635);
        }
        Timer::after_secs(2).await;
    }
}

fn ota_installed() -> bool {
    read_register(0x10001014) == ota::BOOT_START
        && (ota::BOOT_START..0x7c000).contains(&(read_register(ota::BOOT_START as usize + 4) & !1))
}

#[embassy_executor::task]
async fn button_task(mut button: button::EventButton<'static>) {
    loop {
        button.wait_for_low().await;
        Timer::after_millis(30).await;
        if !button.is_low() {
            continue;
        }
        BUTTON_HELD.store(true, Ordering::Release);
        BUTTON_PRESS_COUNT.fetch_add(1, Ordering::AcqRel);
        BUTTON_EVENTS.signal(ButtonEvent::Pressed);
        if matches!(
            select(
                Timer::after_secs(u64::from(RESET_HOLD_SECONDS.load(Ordering::Acquire))),
                button.wait_for_high()
            )
            .await,
            Either::First(())
        ) && button.is_low()
        {
            BUTTON_EVENTS.signal(ButtonEvent::LongHold);
            button.wait_for_high().await;
        }
        BUTTON_HELD.store(false, Ordering::Release);
        Timer::after_millis(30).await;
    }
}

struct Runtime {
    config: Option<ProvisioningConfig>,
    name: DeviceName,
    settings: Settings,
    keys: Option<RollingKeyGenerator>,
    rotation_deadline: Option<Instant>,
    sample_deadline: Instant,
    power: PowerReading,
    battery_state: BatteryState,
    device_id: [u8; 8],
    reset_reason: u32,
    last_button_notification: Cell<u32>,
    led: find_led::Led,
}

impl Runtime {
    async fn load(
        sd: &Softdevice,
        flash: &mut Flash,
        id: [u8; 8],
        reset_reason: u32,
        mut led: find_led::Led,
    ) -> Self {
        let mut profile = loop {
            match ProvisioningStore::new(&mut *flash).load_profile().await {
                Ok(profile) => break profile,
                Err(_) => Timer::after_secs(1).await,
            }
        };
        if profile.name.is_none() {
            let mut random = [0; 4];
            while nrf_softdevice::random_bytes(sd, &mut random).is_err() {
                Timer::after_millis(10).await;
            }
            let mut label = *b"ATAG-00000000";
            let hex = b"0123456789ABCDEF";
            for (index, value) in random.into_iter().enumerate() {
                label[5 + index * 2] = hex[usize::from(value >> 4)];
                label[6 + index * 2] = hex[usize::from(value & 15)];
            }
            profile.name = Some(DeviceName::new(&label).unwrap());
            while ProvisioningStore::new(&mut *flash)
                .persist_profile(profile)
                .await
                .is_err()
            {
                Timer::after_secs(1).await;
            }
        }
        RESET_HOLD_SECONDS.store(
            u32::from(profile.settings.reset_hold_seconds),
            Ordering::Release,
        );
        let config = profile.config;
        led.set_enabled(profile.settings.led_enabled);
        let mut state = Self {
            config,
            name: profile.name.unwrap(),
            settings: profile.settings,
            keys: None,
            rotation_deadline: None,
            sample_deadline: Instant::now(),
            power: PowerReading::default(),
            battery_state: BatteryState::default(),
            device_id: id,
            reset_reason,
            last_button_notification: Cell::new(u32::MAX),
            led,
        };
        if let Some(ProvisioningConfig::Rotating {
            master_public_key,
            symmetric_seed,
            rotation_interval_minutes: _,
        }) = config
        {
            let mut journal =
                CheckpointJournal::new(&mut *flash, config.unwrap().provisioning_id());
            let checkpoint = loop {
                match journal.load().await {
                    Ok(Some(checkpoint)) => break checkpoint,
                    Ok(None) => break Checkpoint::new(0, symmetric_seed),
                    Err(_) => Timer::after_secs(1).await,
                }
            };
            let mut keys = RollingKeyGenerator::resume(&master_public_key, checkpoint).unwrap();
            if keys.checkpoint().rotation() == 0 {
                keys.advance().unwrap();
                while journal.persist(keys.checkpoint()).await.is_err() {
                    Timer::after_secs(1).await;
                }
            }
            CURRENT_ROTATION.store(keys.checkpoint().rotation(), Ordering::Release);
            state.keys = Some(keys);
            state.rotation_deadline =
                Some(Instant::now() + Duration::from_secs(state.rotation_seconds()));
        }
        state
    }

    fn mode(&self) -> u8 {
        self.config.map_or(0, |config| config.mode() as u8)
    }
    fn rotation_seconds(&self) -> u64 {
        match self.config {
            Some(ProvisioningConfig::Rotating { .. }) => {
                u64::from(self.settings.rotation_minutes) * 60
            }
            _ => 0,
        }
    }
    fn key(&self) -> Option<AdvertisementKey> {
        match self.config {
            Some(ProvisioningConfig::Fixed { advertisement_key }) => Some(advertisement_key),
            Some(ProvisioningConfig::Rotating { .. }) => self
                .keys
                .as_ref()
                .map(|keys| keys.current_advertisement_key().unwrap()),
            None => None,
        }
    }
    fn next_deadline(&self, limit: Instant) -> Instant {
        let limit = self.led.next_deadline().map_or(limit, |at| at.min(limit));
        self.rotation_deadline
            .map_or(limit.min(self.sample_deadline), |at| {
                at.min(limit).min(self.sample_deadline)
            })
    }

    // Flash operations are ALWAYS outside the select/cancellation boundaries.
    // nrf-softdevice's flash futures cannot be cancelled while a write is active.
    async fn maintain(
        &mut self,
        flash: &mut Flash,
        voltage: &mut voltage::VoltageMonitor,
        gatt: bool,
    ) {
        self.led.tick();
        while self
            .rotation_deadline
            .is_some_and(|deadline| deadline <= Instant::now())
        {
            let keys = self.keys.as_mut().unwrap();
            keys.advance().unwrap();
            let mut journal =
                CheckpointJournal::new(&mut *flash, self.config.unwrap().provisioning_id());
            while journal.persist(keys.checkpoint()).await.is_err() {
                Timer::after_secs(1).await;
            }
            CURRENT_ROTATION.store(keys.checkpoint().rotation(), Ordering::Release);
            self.rotation_deadline = Some(
                self.rotation_deadline.unwrap() + Duration::from_secs(self.rotation_seconds()),
            );
        }
        if self.sample_deadline <= Instant::now() {
            self.power = voltage.sample().await;
            self.power.battery_mv = self.settings.calibrated_battery_mv(self.power.battery_mv);
            self.battery_state.update_with_thresholds(
                self.power.battery_mv,
                self.settings.battery_low_mv,
                self.settings.battery_recovery_mv,
            );
            BATTERY_MILLIVOLTS.store(u32::from(self.power.battery_mv), Ordering::Release);
            SUPPLY_MILLIVOLTS.store(u32::from(self.power.supply_mv), Ordering::Release);
            BATTERY_RAW_SAMPLE.store(u32::from(self.power.battery_raw), Ordering::Release);
            self.sample_deadline = Instant::now()
                + Duration::from_secs(if gatt {
                    u64::from(self.settings.battery_gatt_seconds)
                } else {
                    u64::from(self.settings.battery_idle_seconds)
                });
        }
    }

    fn publish(
        &self,
        server: &GattServer,
        phase: u8,
        advertising_end: Option<Instant>,
        connection_end: Option<Instant>,
        connection: Option<&Connection>,
    ) {
        let encrypted = connection.is_some_and(|conn| {
            matches!(
                conn.security_mode(),
                SecurityMode::JustWorks | SecurityMode::Mitm | SecurityMode::LescMitm
            )
        });
        let reset_enabled = read_register(0x1000_1200) == 21 && read_register(0x1000_1204) == 21;
        let flags = u8::from(BUTTON_HELD.load(Ordering::Acquire))
            | (u8::from(self.battery_state.undervoltage()) << 1)
            | (u8::from(encrypted) << 2)
            | (u8::from(reset_enabled) << 3)
            | (1 << 4)
            | (u8::from(DCDC_ENABLED) << 5)
            | (u8::from(self.led.hardware().has_led) << 6)
            | (u8::from(self.led.enabled()) << 7);
        let info = Telemetry {
            mode: self.mode(),
            phase,
            flags,
            battery_mv: self.power.battery_mv,
            supply_mv: self.power.supply_mv,
            uptime_seconds: Instant::now().as_secs().min(u64::from(u32::MAX)) as u32,
            rotation: CURRENT_ROTATION.load(Ordering::Acquire),
            rotation_seconds: self.rotation_seconds().min(u64::from(u32::MAX)) as u32,
            reset_reason: self.reset_reason,
            device_id: self.device_id,
            advertising_seconds_left: seconds_left(advertising_end),
            connection_seconds_left: seconds_left(connection_end),
        }
        .encode_with_thresholds(
            self.settings.battery_low_mv,
            self.settings.battery_recovery_mv,
        );
        let _ = server.provisioning.information_set(&info);
        let mut hash = Sha256::new();
        hash.update(b"ATAG-PROFILE-1");
        hash.update([self.name.as_bytes().len() as u8]);
        hash.update(self.name.as_bytes());
        hash.update(self.settings.encode());
        hash.update(
            self.config
                .map_or([0xff; PROVISIONING_WIRE_LEN], |config| config.encode()),
        );
        let mut snapshot = [0; 40];
        snapshot[0] = 1;
        snapshot[1] = self.mode();
        snapshot[2] = u8::from(self.led.hardware().has_led);
        snapshot[3] = u8::from(self.led.enabled()) | (u8::from(self.led.identifying()) << 1);
        snapshot[4..8].copy_from_slice(&CURRENT_ROTATION.load(Ordering::Acquire).to_le_bytes());
        snapshot[8..40].copy_from_slice(&hash.finalize());
        let _ = server.provisioning.profile_snapshot_set(&snapshot);
        let _ = server.provisioning.battery_mv_set(&self.power.battery_mv);
        let count = BUTTON_PRESS_COUNT.load(Ordering::Acquire);
        let _ = server.provisioning.button_events_set(&count);
        let _ = server
            .provisioning
            .pairing_set(&(if encrypted { 2 } else { 0 }));
        if let Some(conn) = connection {
            let _ = server
                .provisioning
                .pairing_notify(conn, &(if encrypted { 2 } else { 0 }));
            if count != self.last_button_notification.get()
                && server
                    .provisioning
                    .button_events_notify(conn, &count)
                    .is_ok()
            {
                self.last_button_notification.set(count);
            }
            if encrypted {
                let _ = server.provisioning.information_notify(conn, &info);
            }
            let _ = server
                .provisioning
                .battery_mv_notify(conn, &self.power.battery_mv);
        }
    }

    fn profile(&self) -> DeviceProfile {
        DeviceProfile {
            config: self.config,
            name: Some(self.name),
            settings: self.settings,
        }
    }

    fn sync_settings(&self, sd: &Softdevice, server: &GattServer) {
        let _ = server.provisioning.name_set(&self.name.into());
        let _ = server.provisioning.settings_set(&self.settings.encode());
        set_device_name(sd, self.name);
    }

    async fn persist_profile(&self, flash: &mut Flash) {
        while ProvisioningStore::new(&mut *flash)
            .persist_profile(self.profile())
            .await
            .is_err()
        {
            Timer::after_secs(1).await;
        }
    }
}

#[embassy_executor::task]
async fn firmware_task(
    sd: &'static Softdevice,
    server: &'static GattServer,
    mut flash: Flash,
    mut voltage: voltage::VoltageMonitor,
    id: [u8; 8],
    reset_reason: u32,
    force_gatt: bool,
    led: find_led::Led,
) {
    let mut state = Runtime::load(sd, &mut flash, id, reset_reason, led).await;
    state.sync_settings(sd, server);
    state.maintain(&mut flash, &mut voltage, false).await;
    let trial_boot = if ota_installed() {
        // Radio/GATT registration, profile load and ADC initialization succeeded.
        match ota::confirm_boot(&mut flash).await {
            Ok(trial) => trial,
            Err(_) => reboot(),
        }
    } else {
        false
    };
    APPLICATION_HEALTHY.store(true, Ordering::Release);
    // Unconfigured boots expose one bounded initial window; subsequent windows
    // require P0.13. Configured devices start Offline Finding immediately.
    let mut request_gatt = state.config.is_none() || trial_boot || force_gatt;
    loop {
        state.maintain(&mut flash, &mut voltage, false).await;
        if request_gatt {
            let result = gatt_window(sd, server, &mut flash, &mut state, &mut voltage).await;
            match result {
                WindowResult::Reboot => reboot(),
                WindowResult::FactoryReset => factory_reset(&mut flash).await,
                WindowResult::Closed => {}
            }
            request_gatt = false;
            continue;
        }
        let event = if let Some(key) = state.key() {
            FIRMWARE_STATUS.store(if state.mode() == 1 { 4 } else { 5 }, Ordering::Release);
            state.publish(server, 1, None, None, None);
            let result = select3(
                advertise_one_key(
                    sd,
                    key,
                    encode_voltage_status(state.power.battery_mv),
                    state.settings,
                ),
                Timer::at(state.next_deadline(
                    Instant::now()
                        + Duration::from_secs(u64::from(state.settings.battery_idle_seconds)),
                )),
                BUTTON_EVENTS.wait(),
            )
            .await;
            match result {
                Either3::First(()) => {
                    Timer::after_millis(100).await;
                    None
                }
                Either3::Second(()) => None,
                Either3::Third(event) => Some(event),
            }
        } else {
            FIRMWARE_STATUS.store(7, Ordering::Release);
            state.publish(server, 0, None, None, None);
            match select(BUTTON_EVENTS.wait(), Timer::at(state.sample_deadline)).await {
                Either::First(event) => Some(event),
                Either::Second(()) => None,
            }
        };
        match event {
            Some(ButtonEvent::Pressed) => request_gatt = true,
            Some(ButtonEvent::LongHold) => factory_reset(&mut flash).await,
            None => {}
        }
    }
}

async fn gatt_window(
    sd: &'static Softdevice,
    server: &'static GattServer,
    flash: &mut Flash,
    state: &mut Runtime,
    voltage: &mut voltage::VoltageMonitor,
) -> WindowResult {
    FIRMWARE_STATUS.store(2, Ordering::Release);
    let _ = server.provisioning.status_set(&STATUS_SETUP);
    state.sample_deadline = Instant::now();
    let mut address = [0; 6];
    address.copy_from_slice(&state.device_id[..6]);
    address[0] |= 0xc0;
    // Stable GATT identity, independent of the rotating Offline Finding address.
    address[1] ^= 0x41;
    set_random_static_address(sd, &address);
    let end =
        Instant::now() + Duration::from_secs(u64::from(state.settings.gatt_advertising_seconds));
    let config = peripheral::Config {
        primary_phy: Phy::M1,
        secondary_phy: Phy::M1,
        tx_power: tx_power(state.settings.tx_power_dbm),
        interval: advertising_units(state.settings.gatt_interval_ms),
        ..Default::default()
    };
    let (scan_data, scan_len) = state.name.scan_response();
    let connection = {
        let mut advertising = pin!(peripheral::advertise_pairable(
            sd,
            peripheral::ConnectableAdvertisement::ScannableUndirected {
                adv_data: GATT_ADVERTISING_DATA,
                scan_data: &scan_data[..scan_len]
            },
            &config,
            &SESSION_SECURITY
        ));
        loop {
            state.maintain(flash, voltage, true).await;
            state.publish(server, 2, Some(end), None, None);
            let tick = state.next_deadline(end.min(Instant::now() + Duration::from_secs(1)));
            match select3(advertising.as_mut(), Timer::at(tick), BUTTON_EVENTS.wait()).await {
                Either3::First(Ok(connection)) => break connection,
                Either3::First(Err(error)) => {
                    record_ble_error(error);
                    return WindowResult::Closed;
                }
                Either3::Second(()) if Instant::now() >= end => return WindowResult::Closed,
                Either3::Third(ButtonEvent::LongHold) => return WindowResult::FactoryReset,
                _ => {}
            }
        }
    };
    FIRMWARE_STATUS.store(3, Ordering::Release);
    let connected_at = Instant::now();
    let mut end = connected_at + Duration::from_secs(u64::from(state.settings.connection_seconds));
    let pending_config = Cell::new(None);
    let pending_control = Cell::new(0_u8);
    let pending_name = Cell::new(None);
    let pending_settings = Cell::new(None);
    let pending_pairing = Cell::new(false);
    let pending_ota_control = Cell::new(None);
    let pending_ota_data = Cell::new(None);
    let ota_busy = Cell::new(false);
    let operations = Signal::<embassy_sync::blocking_mutex::raw::NoopRawMutex, ()>::new();
    let mut ota = OtaSession::new(ota_installed());
    let mut ota_started = None;
    let _ = server.provisioning.ota_status_set(&ota.status());
    let result = {
        let mut run = pin!(gatt_server::run(&connection, server, |event| {
            operations.signal(());
            match event {
                GattServerEvent::Provisioning(ProvisioningServiceEvent::ConfigWrite(wire)) => {
                    match ProvisioningConfig::decode(&wire) {
                        Ok(config) => pending_config.set(Some(config)),
                        Err(error) => {
                            let status = rejected_status(error);
                            let _ = server.provisioning.status_set(&status);
                            let _ = server.provisioning.status_notify(&connection, &status);
                        }
                    }
                }
                GattServerEvent::Provisioning(ProvisioningServiceEvent::ControlWrite(command)) => {
                    pending_control.set(command)
                }
                GattServerEvent::Provisioning(ProvisioningServiceEvent::NameWrite(value)) => {
                    pending_name.set(Some(value))
                }
                GattServerEvent::Provisioning(ProvisioningServiceEvent::SettingsWrite(wire)) => {
                    pending_settings.set(Some(wire))
                }
                GattServerEvent::Provisioning(ProvisioningServiceEvent::PairingWrite(1)) => {
                    pending_pairing.set(true)
                }
                GattServerEvent::Provisioning(ProvisioningServiceEvent::OtaControlWrite(wire)) => {
                    if pending_ota_control.get().is_some() || pending_ota_data.get().is_some() {
                        ota_busy.set(true);
                    } else {
                        pending_ota_control.set(Some(wire));
                    }
                }
                GattServerEvent::Provisioning(ProvisioningServiceEvent::OtaDataWrite(value)) => {
                    if pending_ota_control.get().is_some() || pending_ota_data.get().is_some() {
                        ota_busy.set(true);
                    } else {
                        pending_ota_data.set(Some(value));
                    }
                }
                _ => {}
            }
        }));
        loop {
            state.maintain(flash, voltage, true).await;
            state.publish(server, 3, None, Some(end), Some(&connection));
            let tick = state.next_deadline(end.min(Instant::now() + Duration::from_secs(1)));
            let event = select3(
                run.as_mut(),
                select(Timer::at(tick), operations.wait()),
                BUTTON_EVENTS.wait(),
            )
            .await;
            if let Some(wire) = pending_ota_control.take() {
                if wire[1] == 1 {
                    state.led.stop();
                }
                let was_receiving = ota.receiving();
                let result = ota
                    .control(flash, &wire, OTA_PUBLIC_KEY, state.power.battery_mv)
                    .await;
                if let Err(error) = result {
                    ota.reject(error);
                }
                if !was_receiving && ota.receiving() {
                    ota_started = Some(Instant::now());
                }
                if ota.receiving() {
                    end = (Instant::now() + Duration::from_secs(30))
                        .min(ota_started.unwrap() + Duration::from_secs(900));
                }
                let _ = server.provisioning.ota_status_set(&ota.status());
                let _ = server
                    .provisioning
                    .ota_status_notify(&connection, &ota.status());
                if result == Ok(true) {
                    Timer::after_millis(300).await;
                    break WindowResult::Reboot;
                }
            }
            if let Some(value) = pending_ota_data.take() {
                match ota.data(flash, &value.bytes[..value.len]).await {
                    Ok(()) => {
                        end = (Instant::now() + Duration::from_secs(30))
                            .min(ota_started.unwrap() + Duration::from_secs(900));
                    }
                    Err(error) => ota.reject(error),
                }
                let _ = server.provisioning.ota_status_set(&ota.status());
                let _ = server
                    .provisioning
                    .ota_status_notify(&connection, &ota.status());
            }
            if ota_busy.replace(false) {
                ota.reject(OtaError::Busy);
                let _ = server.provisioning.ota_status_set(&ota.status());
                let _ = server
                    .provisioning
                    .ota_status_notify(&connection, &ota.status());
            }
            if pending_pairing.replace(false) {
                if let Some(handle) = connection.handle() {
                    // SAFETY: session-only Just Works parameters match the handler.
                    let mut parameters: raw::ble_gap_sec_params_t = unsafe { core::mem::zeroed() };
                    parameters.set_io_caps(raw::BLE_GAP_IO_CAPS_NONE as u8);
                    parameters.min_key_size = 7;
                    parameters.max_key_size = 16;
                    parameters.kdist_own.set_enc(1);
                    parameters.kdist_own.set_id(1);
                    parameters.kdist_peer.set_enc(1);
                    parameters.kdist_peer.set_id(1);
                    let result = unsafe { raw::sd_ble_gap_authenticate(handle, &parameters) };
                    if result != raw::NRF_SUCCESS && result != raw::NRF_ERROR_INVALID_STATE {
                        LAST_BLE_ERROR.store(result, Ordering::Release);
                    }
                }
            }
            if let Some(raw_name) = pending_name.take() {
                let status = if let Ok(name) = DeviceName::new(&raw_name.bytes[..raw_name.len]) {
                    state.name = name;
                    state.persist_profile(flash).await;
                    operation_status(3, 0, state.mode())
                } else {
                    operation_status(4, 1, state.mode())
                };
                state.sync_settings(sd, server);
                let _ = server.provisioning.status_set(&status);
                let _ = server.provisioning.status_notify(&connection, &status);
            }
            if let Some(wire) = pending_settings.take() {
                let decoded = Settings::decode(&wire);
                let status = if decoded.as_ref().is_ok_and(|settings| {
                    !state
                        .led
                        .hardware()
                        .accepts_led_setting(settings.led_enabled)
                }) {
                    operation_status(6, 2, state.mode())
                } else if let Ok(settings) = decoded {
                    let rotation_changed =
                        state.settings.rotation_minutes != settings.rotation_minutes;
                    state.settings = settings;
                    state.led.set_enabled(settings.led_enabled);
                    state.persist_profile(flash).await;
                    RESET_HOLD_SECONDS
                        .store(u32::from(settings.reset_hold_seconds), Ordering::Release);
                    if rotation_changed && state.keys.is_some() {
                        state.rotation_deadline =
                            Some(Instant::now() + Duration::from_secs(state.rotation_seconds()));
                    }
                    state.sample_deadline = Instant::now();
                    end =
                        connected_at + Duration::from_secs(u64::from(settings.connection_seconds));
                    if let Some(handle) = connection.handle() {
                        // SAFETY: the connection is live and settings validate supported powers.
                        let _ = unsafe {
                            raw::sd_ble_gap_tx_power_set(
                                raw::BLE_GAP_TX_POWER_ROLES_BLE_GAP_TX_POWER_ROLE_CONN as u8,
                                handle,
                                settings.tx_power_dbm,
                            )
                        };
                    }
                    operation_status(5, 0, state.mode())
                } else {
                    operation_status(6, 1, state.mode())
                };
                state.sync_settings(sd, server);
                let _ = server.provisioning.status_set(&status);
                let _ = server.provisioning.status_notify(&connection, &status);
                if Instant::now() >= end {
                    Timer::after_millis(250).await;
                    break WindowResult::Closed;
                }
            }
            if let Some(config) = pending_config.take() {
                // Not inside select: a pending SoftDevice flash write must finish.
                while ProvisioningStore::new(&mut *flash)
                    .persist(config)
                    .await
                    .is_err()
                {
                    Timer::after_secs(1).await;
                }
                let status = accepted_status(config);
                let _ = server.provisioning.status_set(&status);
                let _ = server.provisioning.status_notify(&connection, &status);
                Timer::after_millis(250).await;
                break WindowResult::Reboot;
            }
            match pending_control.replace(0) {
                1 => break WindowResult::Reboot,
                2 => break WindowResult::FactoryReset,
                3 => {
                    let status = if ota.receiving() {
                        operation_status(9, 3, state.mode())
                    } else {
                        match state.led.start() {
                            Ok(()) => operation_status(7, 0, state.mode()),
                            Err(error) => operation_status(9, error as u8, state.mode()),
                        }
                    };
                    let _ = server.provisioning.status_set(&status);
                    let _ = server.provisioning.status_notify(&connection, &status);
                }
                4 => {
                    state.led.stop();
                    let status = operation_status(8, 0, state.mode());
                    let _ = server.provisioning.status_set(&status);
                    let _ = server.provisioning.status_notify(&connection, &status);
                }
                _ => {}
            }
            match event {
                Either3::First(_) => break WindowResult::Closed,
                Either3::Second(_) if Instant::now() >= end => break WindowResult::Closed,
                Either3::Third(ButtonEvent::LongHold) => break WindowResult::FactoryReset,
                _ => {}
            }
        }
    };
    state.led.stop();
    let _ = connection.disconnect();
    let disconnect_end = Instant::now() + Duration::from_secs(2);
    while connection.handle().is_some() {
        if Instant::now() >= disconnect_end {
            reboot();
        }
        Timer::after_millis(20).await;
    }
    result
}

async fn advertise_one_key(
    sd: &'static Softdevice,
    key: AdvertisementKey,
    status: u8,
    settings: Settings,
) {
    let packet = BleAdvertisement::new(key, status, 0);
    set_random_static_address(sd, packet.random_static_address());
    let config = peripheral::Config {
        primary_phy: Phy::M1,
        secondary_phy: Phy::M1,
        tx_power: tx_power(settings.tx_power_dbm),
        interval: advertising_units(settings.advertising_interval_ms),
        ..Default::default()
    };
    if let Err(error) = peripheral::advertise(
        sd,
        peripheral::NonconnectableAdvertisement::NonscannableUndirected {
            adv_data: packet.advertising_data(),
        },
        &config,
    )
    .await
    {
        record_ble_error(error);
    }
}

fn record_ble_error(error: peripheral::AdvertiseError) {
    let code = match error {
        peripheral::AdvertiseError::Raw(error) => error as u32,
        peripheral::AdvertiseError::Timeout => raw::NRF_ERROR_TIMEOUT,
        peripheral::AdvertiseError::NoFreeConn => raw::NRF_ERROR_CONN_COUNT,
    };
    LAST_BLE_ERROR.store(code, Ordering::Release);
}

async fn factory_reset(flash: &mut Flash) -> ! {
    FIRMWARE_STATUS.store(6, Ordering::Release);
    while ProvisioningStore::new(&mut *flash).reset().await.is_err() {
        Timer::after_secs(1).await;
    }
    reboot()
}

fn accepted_status(config: ProvisioningConfig) -> [u8; 8] {
    [
        1,
        1,
        0,
        config.mode() as u8,
        PROVISIONING_WIRE_LEN as u8,
        0,
        0,
        0,
    ]
}
fn operation_status(operation: u8, error: u8, mode: u8) -> [u8; 8] {
    [1, operation, error, mode, 0, 0, 0, 0]
}

fn advertising_units(milliseconds: u32) -> u32 {
    (milliseconds * 8 + 2) / 5
}

fn tx_power(dbm: i8) -> TxPower {
    match dbm {
        -40 => TxPower::Minus40dBm,
        -20 => TxPower::Minus20dBm,
        -16 => TxPower::Minus16dBm,
        -12 => TxPower::Minus12dBm,
        -8 => TxPower::Minus8dBm,
        -4 => TxPower::Minus4dBm,
        3 => TxPower::Plus3dBm,
        4 => TxPower::Plus4dBm,
        _ => TxPower::ZerodBm,
    }
}

fn set_device_name(_sd: &Softdevice, name: DeviceName) {
    // SAFETY: stack-owned GAP storage copies the validated bytes. Standard GAP
    // writes stay disabled; the protected vendor characteristic handles changes.
    let permissions: raw::ble_gap_conn_sec_mode_t = unsafe { core::mem::zeroed() };
    let result = unsafe {
        raw::sd_ble_gap_device_name_set(
            &permissions,
            name.as_bytes().as_ptr(),
            name.as_bytes().len() as u16,
        )
    };
    assert_eq!(result, raw::NRF_SUCCESS);
}
fn rejected_status(error: ProvisioningError) -> [u8; 8] {
    let code = match error {
        ProvisioningError::BadMagic => 1,
        ProvisioningError::UnsupportedVersion => 2,
        ProvisioningError::UnsupportedMode => 3,
        ProvisioningError::BadChecksum => 4,
        ProvisioningError::InvalidFixedKey => 5,
        ProvisioningError::InvalidMasterPublicKey => 6,
        ProvisioningError::InvalidRotationInterval => 7,
        ProvisioningError::NonzeroReservedBytes => 8,
    };
    [1, 2, code, 0, PROVISIONING_WIRE_LEN as u8, 0, 0, 0]
}
fn seconds_left(end: Option<Instant>) -> u16 {
    end.map_or(0, |end| {
        end.saturating_duration_since(Instant::now())
            .as_secs()
            .min(u64::from(u16::MAX)) as u16
    })
}
fn set_random_static_address(sd: &Softdevice, protocol_order: &[u8; 6]) {
    let mut address = *protocol_order;
    address.reverse();
    ble::set_address(sd, &Address::new(AddressType::RandomStatic, address));
}
fn softdevice_config() -> nrf_softdevice::Config {
    // SAFETY: zero means no peer write access; remaining fields are filled below.
    let mut device_name: raw::ble_gap_cfg_device_name_t = unsafe { core::mem::zeroed() };
    device_name.set_vloc(raw::BLE_GATTS_VLOC_STACK as u8);
    device_name.p_value = b"ATAG".as_ptr() as *mut u8;
    device_name.current_len = 4;
    device_name.max_len = MAX_NAME_BYTES as u16;
    nrf_softdevice::Config {
        gap_device_name: Some(device_name),
        clock: Some(raw::nrf_clock_lf_cfg_t {
            source: raw::NRF_CLOCK_LF_SRC_XTAL as u8,
            rc_ctiv: 0,
            rc_temp_ctiv: 0,
            accuracy: raw::NRF_CLOCK_LF_ACCURACY_20_PPM as u8,
        }),
        conn_gap: Some(raw::ble_gap_conn_cfg_t {
            conn_count: 1,
            event_length: 24,
        }),
        conn_gatt: Some(raw::ble_gatt_conn_cfg_t { att_mtu: 128 }),
        gap_role_count: Some(raw::ble_gap_cfg_role_count_t {
            adv_set_count: 1,
            periph_role_count: 1,
        }),
        gatts_attr_tab_size: Some(raw::ble_gatts_cfg_attr_tab_size_t {
            attr_tab_size: 4096,
        }),
        ..Default::default()
    }
}
fn device_id() -> [u8; 8] {
    let mut id = [0; 8];
    id[..4].copy_from_slice(&read_register(0x1000_0060).to_le_bytes());
    id[4..].copy_from_slice(&read_register(0x1000_0064).to_le_bytes());
    id
}
fn serial_string(id: [u8; 8]) -> [u8; 16] {
    let digits = b"0123456789abcdef";
    let mut output = [0; 16];
    for (i, byte) in id.iter().enumerate() {
        output[2 * i] = digits[(byte >> 4) as usize];
        output[2 * i + 1] = digits[(byte & 15) as usize];
    }
    output
}
fn read_register(address: usize) -> u32 {
    // SAFETY: all callers provide fixed aligned nRF52832 register addresses.
    unsafe { ptr::read_volatile(address as *const u32) }
}
fn write_register(address: usize, value: u32) {
    // SAFETY: this is only used for RESETREAS before enabling the SoftDevice.
    unsafe { ptr::write_volatile(address as *mut u32, value) };
}
fn reboot() -> ! {
    cortex_m::peripheral::SCB::sys_reset()
}
