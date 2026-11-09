use crate::service;
use anyhow::Result;
use atag_agent::server::ServerConfig;
use std::{net::SocketAddr, sync::Arc};
use tokio::sync::oneshot;
use tray_icon::{
    Icon, TrayIcon, TrayIconBuilder,
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem},
};
use url::Url;

const START: &str = "start";
const STOP: &str = "stop";
const OPEN_WEB: &str = "open-web";
const QUIT: &str = "quit";

enum Event {
    Menu(MenuEvent),
    Service(service::Event),
}

type Dispatch = Arc<dyn Fn(Event) + Send + Sync>;

enum Status {
    Stopped,
    Starting,
    Running(SocketAddr),
    Stopping,
    Failed(String),
}

struct Tray {
    icon: TrayIcon,
    status_item: MenuItem,
    start_item: MenuItem,
    stop_item: MenuItem,
    config: ServerConfig,
    web_url: Url,
    web_opened: bool,
    dispatch: Dispatch,
    status: Status,
    shutdown: Option<oneshot::Sender<()>>,
    quitting: bool,
}

impl Tray {
    fn new(config: ServerConfig, web_url: Url, dispatch: Dispatch) -> Result<Self> {
        let menu = Menu::new();
        let status_item = MenuItem::new("ATAG Agent · 已停止", false, None);
        let start_item = MenuItem::with_id(START, "启动 Agent", true, None);
        let stop_item = MenuItem::with_id(STOP, "停止 Agent", false, None);
        menu.append_items(&[
            &status_item,
            &PredefinedMenuItem::separator(),
            &start_item,
            &stop_item,
        ])?;
        menu.append_items(&[
            &MenuItem::with_id(OPEN_WEB, "打开 ATAG 网页", true, None),
            &PredefinedMenuItem::separator(),
            &MenuItem::with_id(QUIT, "退出", true, None),
        ])?;

        let builder = TrayIconBuilder::new()
            .with_id("io.atag.agent-tray")
            .with_menu(Box::new(menu))
            .with_tooltip("ATAG Agent")
            .with_menu_on_left_click(true);
        // Both rasters are derived from the ATAG web favicon. The Mac template omits its background.
        #[cfg(target_os = "macos")]
        let builder = builder.with_icon_templated(Icon::from_rgba(
            include_bytes!("../assets/icon-template.rgba").to_vec(),
            32,
            32,
        )?);
        #[cfg(not(target_os = "macos"))]
        let builder = builder.with_icon(Icon::from_rgba(
            include_bytes!("../assets/icon.rgba").to_vec(),
            32,
            32,
        )?);

        let mut tray = Self {
            icon: builder.build()?,
            status_item,
            start_item,
            stop_item,
            config,
            web_url,
            web_opened: false,
            dispatch,
            status: Status::Stopped,
            shutdown: None,
            quitting: false,
        };
        tray.start();
        Ok(tray)
    }

    fn can_start(&self) -> bool {
        !self.quitting && matches!(self.status, Status::Stopped | Status::Failed(_))
    }

    fn start(&mut self) {
        if !self.can_start() {
            return;
        }
        let dispatch = self.dispatch.clone();
        match service::start(self.config.clone(), move |event| {
            dispatch(Event::Service(event))
        }) {
            Ok(shutdown) => {
                self.shutdown = Some(shutdown);
                self.status = Status::Starting;
            }
            Err(error) => self.fail(error.to_string()),
        }
        self.refresh();
    }

    fn stop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            self.status = Status::Stopping;
            let _ = shutdown.send(());
            self.refresh();
        }
    }

    fn fail(&mut self, message: String) {
        eprintln!("atag-agent-tray: {message}");
        self.status = Status::Failed(message);
    }

    fn refresh(&self) {
        let label = match &self.status {
            Status::Stopped => "ATAG Agent · 已停止".into(),
            Status::Starting => "ATAG Agent · 正在启动…".into(),
            Status::Running(address) => format!("ATAG Agent API · http://{address}"),
            Status::Stopping => "ATAG Agent · 正在停止…".into(),
            Status::Failed(error) => format!("ATAG Agent · {error}"),
        };
        self.status_item.set_text(&label);
        let _ = self.icon.set_tooltip(Some(&label));
        self.start_item.set_enabled(self.can_start());
        self.stop_item.set_enabled(self.shutdown.is_some());
    }

    fn open_web(&mut self) {
        match open::that_detached(self.web_url.as_str()) {
            Ok(()) => self.web_opened = true,
            Err(error) => eprintln!("atag-agent-tray: 打开网页失败: {error}"),
        }
    }

    /// Return true once a requested exit can safely close the tray.
    fn handle(&mut self, event: Event) -> bool {
        match event {
            Event::Menu(event) => match event.id().as_ref() {
                START => self.start(),
                STOP => self.stop(),
                OPEN_WEB => self.open_web(),
                QUIT => {
                    self.quitting = true;
                    self.stop();
                }
                _ => {}
            },
            Event::Service(service::Event::Started(address)) => {
                if matches!(self.status, Status::Starting) {
                    println!("ATAG v1 bridge listening on http://{address}");
                    self.status = Status::Running(address);
                    self.refresh();
                    if !self.web_opened {
                        self.open_web();
                    }
                }
            }
            Event::Service(service::Event::Finished(result)) => {
                self.shutdown = None;
                match result {
                    Ok(()) => self.status = Status::Stopped,
                    Err(error) => self.fail(error),
                }
                self.refresh();
            }
        }
        self.quitting && matches!(self.status, Status::Stopped | Status::Failed(_))
    }
}

fn forward_menu_events(dispatch: &Dispatch) {
    let dispatch = dispatch.clone();
    MenuEvent::set_event_handler(Some(move |event| dispatch(Event::Menu(event))));
}

#[cfg(target_os = "linux")]
pub fn run(config: ServerConfig, web_url: Url) -> Result<()> {
    let (events, incoming) = std::sync::mpsc::channel();
    let dispatch: Dispatch = Arc::new(move |event| {
        let _ = events.send(event);
    });
    forward_menu_events(&dispatch);
    let mut tray = Tray::new(config, web_url, dispatch)?;
    // KSNI supplies the native D-Bus event loop and delivers menu events from its worker.
    for event in incoming {
        if tray.handle(event) {
            break;
        }
    }
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub fn run(config: ServerConfig, web_url: Url) -> Result<()> {
    use tao::{
        event::{Event as TaoEvent, StartCause},
        event_loop::{ControlFlow, EventLoopBuilder},
    };

    let event_loop = EventLoopBuilder::<Event>::with_user_event().build();
    #[cfg(target_os = "macos")]
    let event_loop = {
        use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
        let mut event_loop = event_loop;
        event_loop.set_activation_policy(ActivationPolicy::Accessory);
        event_loop.set_dock_visibility(false);
        event_loop.set_activate_ignoring_other_apps(false);
        event_loop
    };
    let proxy = event_loop.create_proxy();
    let dispatch: Dispatch = Arc::new(move |event| {
        let _ = proxy.send_event(event);
    });
    forward_menu_events(&dispatch);

    let mut tray = None;
    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::Wait;
        match event {
            TaoEvent::NewEvents(StartCause::Init) => {
                match Tray::new(config.clone(), web_url.clone(), dispatch.clone()) {
                    Ok(app) => tray = Some(app),
                    Err(error) => {
                        eprintln!("atag-agent-tray: {error:#}");
                        *flow = ControlFlow::ExitWithCode(1);
                    }
                }
            }
            TaoEvent::UserEvent(event) => {
                if tray.as_mut().is_some_and(|tray| tray.handle(event)) {
                    *flow = ControlFlow::Exit;
                }
            }
            TaoEvent::LoopDestroyed => {
                tray.take();
            }
            _ => {}
        }
    })
}
