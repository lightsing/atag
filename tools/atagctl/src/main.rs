use std::{
    env,
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::ExitCode,
};

use atag::{AdvertisementKey, ProvisioningConfig, RollingPrivateKeyGenerator, SYMMETRIC_KEY_LEN};
use atag_firmware_nrf52832::{
    device_name::DeviceName,
    provisioning_store::{DeviceProfile, encode_committed_record, encode_profile_record},
    settings::{SETTINGS_WIRE_LEN, Settings},
};
use p224::{SecretKey, elliptic_curve::sec1::ToEncodedPoint};
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};

const DEFAULT_ROTATING_KEY_COUNT: usize = 32;
const MAX_ROTATING_KEY_COUNT: usize = 512;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("atagctl: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let mut args = env::args();
    let _program = args.next();
    let command = args.next().ok_or_else(usage)?;
    let output_dir = PathBuf::from(args.next().ok_or_else(usage)?);
    let name = args.next().ok_or_else(usage)?;
    validate_name(&name)?;

    match command.as_str() {
        "generate-unconfigured" => {
            let display_name = args.next().ok_or_else(usage)?;
            let settings = if let Some(path) = args.next() {
                let bytes = read_exact::<SETTINGS_WIRE_LEN>(&PathBuf::from(path))?;
                Settings::decode(&bytes).map_err(|error| format!("invalid settings: {error:?}"))?
            } else {
                Settings::default()
            };
            if args.next().is_some() {
                return Err(usage());
            }
            let display_name = DeviceName::new(display_name.as_bytes())
                .map_err(|error| format!("invalid device name: {error:?}"))?;
            prepare_output_dir(&output_dir)?;
            let profile = DeviceProfile {
                name: Some(display_name),
                settings,
                ..Default::default()
            };
            write_new(
                &output_dir.join(format!("{name}.provisioning-record.bin")),
                &encode_profile_record(0, profile),
            )?;
            println!(
                "created unconfigured named profile in {}",
                output_dir.display()
            );
            Ok(())
        }
        "generate-fixed" => {
            if args.next().is_some() {
                return Err(usage());
            }
            generate_fixed(&output_dir, &name)
        }
        "generate-rotating" => {
            let interval_minutes =
                args.next().ok_or_else(usage)?.parse::<u32>().map_err(|_| {
                    "rotation interval must be an integer number of minutes".to_owned()
                })?;
            if interval_minutes == 0 {
                return Err("rotation interval must be at least one minute".to_owned());
            }
            let key_count = args
                .next()
                .map(|value| {
                    value
                        .parse::<usize>()
                        .map_err(|_| "key count must be an integer".to_owned())
                })
                .transpose()?
                .unwrap_or(DEFAULT_ROTATING_KEY_COUNT);
            if !(1..=MAX_ROTATING_KEY_COUNT).contains(&key_count) {
                return Err(format!(
                    "key count must be between 1 and {MAX_ROTATING_KEY_COUNT}"
                ));
            }
            if args.next().is_some() {
                return Err(usage());
            }
            generate_rotating(&output_dir, &name, interval_minutes, key_count)
        }
        "export-rotating" => {
            let start_rotation = args
                .next()
                .ok_or_else(usage)?
                .parse::<u32>()
                .map_err(|_| "start rotation must be an integer".to_owned())?;
            if start_rotation == 0 {
                return Err("start rotation must be at least one".to_owned());
            }
            let key_count = args
                .next()
                .map(|value| {
                    value
                        .parse::<usize>()
                        .map_err(|_| "key count must be an integer".to_owned())
                })
                .transpose()?
                .unwrap_or(DEFAULT_ROTATING_KEY_COUNT);
            if !(1..=MAX_ROTATING_KEY_COUNT).contains(&key_count) {
                return Err(format!(
                    "key count must be between 1 and {MAX_ROTATING_KEY_COUNT}"
                ));
            }
            if args.next().is_some() {
                return Err(usage());
            }
            export_rotating(&output_dir, &name, start_rotation, key_count)
        }
        _ => Err(usage()),
    }
}

fn usage() -> String {
    "usage:\n  atagctl generate-unconfigured <output-dir> <file-name> <display-name>\n  atagctl generate-fixed <output-dir> <name>\n  atagctl generate-rotating <output-dir> <name> <interval-minutes> [key-count]\n  atagctl export-rotating <bundle-dir> <name> <start-rotation> [key-count]".to_owned()
}

fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || matches!(name, "." | "..")
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("name may contain only letters, digits, '.', '-', and '_'".to_owned());
    }
    Ok(())
}

fn generate_fixed(output_dir: &Path, name: &str) -> Result<(), String> {
    prepare_output_dir(output_dir)?;
    let secret = SecretKey::random(&mut OsRng);
    let private = secret.to_bytes();
    let public = secret.public_key().to_encoded_point(false);
    let mut advertisement_key = [0_u8; 28];
    advertisement_key.copy_from_slice(public.x().expect("uncompressed P-224 x-coordinate"));
    let config = ProvisioningConfig::Fixed {
        advertisement_key: AdvertisementKey::from_bytes(advertisement_key),
    };

    let config_path = output_dir.join(format!("{name}.atag-config.bin"));
    let private_path = output_dir.join(format!("{name}.private-key.bin"));
    let public_path = output_dir.join(format!("{name}.advertisement-key.bin"));
    let json_path = output_dir.join(format!("{name}_devices.json"));
    let manifest_path = output_dir.join(format!("{name}.manifest.txt"));
    let record_path = output_dir.join(format!("{name}.provisioning-record.bin"));

    write_new(&config_path, &config.encode())?;
    write_new(&record_path, &encode_committed_record(0, Some(config)))?;
    write_new(&private_path, private.as_ref())?;
    write_new(&public_path, &advertisement_key)?;
    let private_keys = [private.as_ref()];
    write_devices_json(&json_path, name, config.provisioning_id(), &private_keys)?;

    let manifest = format!(
        "mode=fixed\nname={name}\nprovisioning_id={:08x}\nadvertisement_key_base64={}\nreport_id_base64={}\n",
        config.provisioning_id(),
        base64_encode(&advertisement_key),
        report_id(&advertisement_key),
    );
    write_new(&manifest_path, manifest.as_bytes())?;

    println!("created fixed-key bundle in {}", output_dir.display());
    println!("GATT payload: {}", config_path.display());
    println!("Macless Haystack import: {}", json_path.display());
    println!("private material was written with mode 0600 and was not printed");
    Ok(())
}

fn generate_rotating(
    output_dir: &Path,
    name: &str,
    interval_minutes: u32,
    key_count: usize,
) -> Result<(), String> {
    prepare_output_dir(output_dir)?;
    let secret = SecretKey::random(&mut OsRng);
    let master_private = secret.to_bytes();
    let public = secret.public_key().to_encoded_point(false);
    let mut master_public = [0_u8; 57];
    master_public.copy_from_slice(public.as_bytes());
    let mut symmetric_seed = [0_u8; SYMMETRIC_KEY_LEN];
    OsRng.fill_bytes(&mut symmetric_seed);

    let config = ProvisioningConfig::Rotating {
        master_public_key: master_public,
        symmetric_seed,
        rotation_interval_minutes: interval_minutes,
    };
    let mut generator = RollingPrivateKeyGenerator::new(master_private.as_ref(), symmetric_seed)
        .map_err(|error| error.to_string())?;
    let mut private_keys = Vec::with_capacity(key_count);
    let mut manifest = format!(
        "mode=rotating\nname={name}\nprovisioning_id={:08x}\nrotation_interval_minutes={interval_minutes}\nkey_count={key_count}\n",
        config.provisioning_id(),
    );

    for _ in 0..key_count {
        let rotation = generator.advance().map_err(|error| error.to_string())?;
        manifest.push_str(&format!(
            "rotation.{}.advertisement_key_base64={}\nrotation.{}.report_id_base64={}\n",
            rotation.number(),
            base64_encode(rotation.advertisement_key().as_bytes()),
            rotation.number(),
            report_id(rotation.advertisement_key().as_bytes()),
        ));
        private_keys.push(rotation.private_key().into_bytes());
    }

    let config_path = output_dir.join(format!("{name}.atag-config.bin"));
    let private_path = output_dir.join(format!("{name}.master-private-key.bin"));
    let public_path = output_dir.join(format!("{name}.master-public-key.bin"));
    let seed_path = output_dir.join(format!("{name}.symmetric-seed.bin"));
    let json_path = output_dir.join(format!("{name}_devices.json"));
    let manifest_path = output_dir.join(format!("{name}.manifest.txt"));
    let record_path = output_dir.join(format!("{name}.provisioning-record.bin"));

    write_new(&config_path, &config.encode())?;
    write_new(&record_path, &encode_committed_record(0, Some(config)))?;
    write_new(&private_path, master_private.as_ref())?;
    write_new(&public_path, &master_public)?;
    write_new(&seed_path, &symmetric_seed)?;
    let private_refs: Vec<&[u8]> = private_keys.iter().map(<[u8; 28]>::as_slice).collect();
    write_devices_json(&json_path, name, config.provisioning_id(), &private_refs)?;
    write_new(&manifest_path, manifest.as_bytes())?;

    println!(
        "created {key_count}-rotation bundle in {}",
        output_dir.display()
    );
    println!("GATT payload: {}", config_path.display());
    println!("Macless Haystack import: {}", json_path.display());
    println!("private material was written with mode 0600 and was not printed");
    Ok(())
}

fn export_rotating(
    bundle_dir: &Path,
    name: &str,
    start_rotation: u32,
    key_count: usize,
) -> Result<(), String> {
    let config_path = bundle_dir.join(format!("{name}.atag-config.bin"));
    let private_path = bundle_dir.join(format!("{name}.master-private-key.bin"));
    let seed_path = bundle_dir.join(format!("{name}.symmetric-seed.bin"));
    let config_bytes = read_exact::<104>(&config_path)?;
    let config = ProvisioningConfig::decode(&config_bytes)
        .map_err(|error| format!("decode {}: {error:?}", config_path.display()))?;
    let ProvisioningConfig::Rotating {
        master_public_key,
        symmetric_seed,
        ..
    } = config
    else {
        return Err(format!(
            "{} is not a rotating bundle",
            config_path.display()
        ));
    };

    let stored_seed = read_exact::<SYMMETRIC_KEY_LEN>(&seed_path)?;
    if stored_seed != symmetric_seed {
        return Err("stored symmetric seed does not match the GATT configuration".to_owned());
    }
    let master_private = read_exact::<28>(&private_path)?;
    let secret = SecretKey::from_slice(&master_private)
        .map_err(|_| "stored master private key is invalid".to_owned())?;
    if secret.public_key().to_encoded_point(false).as_bytes() != master_public_key {
        return Err("stored master private key does not match the GATT configuration".to_owned());
    }

    let private_keys =
        derive_private_window(&master_private, symmetric_seed, start_rotation, key_count)?;
    let end_rotation = start_rotation + key_count as u32 - 1;
    let output_path = bundle_dir.join(format!(
        "{name}_rotations_{start_rotation}-{end_rotation}_devices.json"
    ));
    let private_refs: Vec<&[u8]> = private_keys.iter().map(<[u8; 28]>::as_slice).collect();
    let window_name = format!("{name} rotations {start_rotation}-{end_rotation}");
    write_devices_json(
        &output_path,
        &window_name,
        config.provisioning_id(),
        &private_refs,
    )?;

    println!(
        "exported rotations {start_rotation}-{end_rotation} to {}",
        output_path.display()
    );
    println!("private material was written with mode 0600 and was not printed");
    Ok(())
}

fn derive_private_window(
    master_private: &[u8; 28],
    symmetric_seed: [u8; SYMMETRIC_KEY_LEN],
    start_rotation: u32,
    key_count: usize,
) -> Result<Vec<[u8; 28]>, String> {
    let end_rotation = start_rotation
        .checked_add(key_count as u32 - 1)
        .ok_or_else(|| "rotation window exceeds u32::MAX".to_owned())?;
    let mut generator = RollingPrivateKeyGenerator::new(master_private, symmetric_seed)
        .map_err(|error| error.to_string())?;
    let mut private_keys = Vec::with_capacity(key_count);
    for number in 1..=end_rotation {
        let rotation = generator.advance().map_err(|error| error.to_string())?;
        if number >= start_rotation {
            private_keys.push(rotation.private_key().into_bytes());
        }
    }
    Ok(private_keys)
}

fn prepare_output_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("create output directory {}: {error}", path.display()))?;
    let mut permissions = fs::metadata(path)
        .map_err(|error| format!("inspect output directory {}: {error}", path.display()))?
        .permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(path, permissions)
        .map_err(|error| format!("protect output directory {}: {error}", path.display()))
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| format!("create {}: {error}", path.display()))?;
    file.write_all(bytes)
        .map_err(|error| format!("write {}: {error}", path.display()))?;
    file.sync_all()
        .map_err(|error| format!("sync {}: {error}", path.display()))
}

fn read_exact<const N: usize>(path: &Path) -> Result<[u8; N], String> {
    let bytes = fs::read(path).map_err(|error| format!("read {}: {error}", path.display()))?;
    bytes.try_into().map_err(|bytes: Vec<u8>| {
        format!(
            "{} must be exactly {N} bytes, got {}",
            path.display(),
            bytes.len()
        )
    })
}

fn write_devices_json(
    path: &Path,
    name: &str,
    id: u32,
    private_keys: &[&[u8]],
) -> Result<(), String> {
    let (primary, additional) = private_keys
        .split_last()
        .ok_or_else(|| "at least one private key is required".to_owned())?;
    let additional = additional
        .iter()
        .map(|key| format!("\"{}\"", base64_encode(key)))
        .collect::<Vec<_>>()
        .join(",");
    let json = format!(
        "[{{\n  \"id\": {id},\n  \"colorComponents\": [0,1,0,1],\n  \"name\": \"{}\",\n  \"privateKey\": \"{}\",\n  \"icon\": \"\",\n  \"isActive\": true,\n  \"additionalKeys\": [{additional}]\n}}]\n",
        json_escape(name),
        base64_encode(primary),
    );
    write_new(path, json.as_bytes())
}

fn report_id(advertisement_key: &[u8]) -> String {
    base64_encode(&Sha256::digest(advertisement_key))
}

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        output.push(ALPHABET[((value >> 18) & 0x3f) as usize] as char);
        output.push(ALPHABET[((value >> 12) & 0x3f) as usize] as char);
        output.push(if chunk.len() > 1 {
            ALPHABET[((value >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            ALPHABET[(value & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    output
}

fn json_escape(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            character if character.is_control() => {
                use std::fmt::Write as _;
                let _ = write!(output, "\\u{:04x}", character as u32);
            }
            character => output.push(character),
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn file_name_validation_rejects_paths() {
        assert!(validate_name("fixed-test").is_ok());
        assert!(validate_name("../secret").is_err());
        assert!(validate_name("nested/key").is_err());
    }

    #[test]
    fn private_key_windows_are_one_based_and_contiguous() {
        let master_private = [1_u8; 28];
        let seed = [0x42; SYMMETRIC_KEY_LEN];
        let window = derive_private_window(&master_private, seed, 2, 2).unwrap();

        let mut generator = RollingPrivateKeyGenerator::new(&master_private, seed).unwrap();
        let _first = generator.advance().unwrap();
        let second = generator.advance().unwrap().private_key().into_bytes();
        let third = generator.advance().unwrap().private_key().into_bytes();
        assert_eq!(window, vec![second, third]);
    }
}
