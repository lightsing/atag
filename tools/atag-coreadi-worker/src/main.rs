//! Runs one emulation session over private pipes. The agent owns the state and network.
use adi_core::CoreAdi;
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{
    env, fs,
    io::{self, BufRead, IsTerminal, Read, Write},
    process::ExitCode,
};

#[path = "../../atag-agent/src/anisette/mac_coreadi/protocol.rs"]
mod protocol;
use protocol::{FRAME_LIMIT, LIBRARY_LIMIT, Reply, Request, decode_blob, store_file};

const DS_ID: i64 = -2;

fn receive(input: &mut impl BufRead) -> Option<Request> {
    let mut line = Vec::new();
    input
        .take(FRAME_LIMIT + 1)
        .read_until(b'\n', &mut line)
        .ok()?;
    if line.len() as u64 > FRAME_LIMIT || line.last() != Some(&b'\n') {
        return None;
    }
    serde_json::from_slice(&line).ok()
}

fn send(output: &mut impl Write, reply: Reply) -> Option<()> {
    let line = serde_json::to_vec(&reply).ok()?;
    if line.len() as u64 >= FRAME_LIMIT {
        return None;
    }
    output.write_all(&line).ok()?;
    output.write_all(b"\n").ok()?;
    output.flush().ok()
}

fn run(mut adi: CoreAdi, input: &mut impl BufRead, output: &mut impl Write) -> Option<()> {
    let Request::Open { host_uuid, store } = receive(input)? else {
        return None;
    };
    adi.set_host_uuid(host_uuid);
    for (name, encoded) in store {
        if !store_file(&name) {
            return None;
        }
        adi.store_put(&name, &decode_blob(&encoded)?);
    }
    if !adi.begin_session().ok()?.ok() {
        return None;
    }
    let provisioned = adi.is_machine_provisioned(DS_ID).ok()?.ret == 0;
    send(output, Reply::Opened { provisioned })?;
    match receive(input)? {
        Request::Headers if provisioned => {}
        Request::Provision { spim } if !provisioned => {
            let start = adi.provisioning_start(DS_ID, &decode_blob(&spim)?).ok()?;
            if !start.reply.ok() || start.cpim.is_empty() {
                return None;
            }
            send(
                output,
                Reply::Started {
                    cpim: STANDARD.encode(start.cpim),
                },
            )?;
            let Request::Finish { ptm, tk, routing } = receive(input)? else {
                return None;
            };
            adi.provisioning_finish(
                DS_ID,
                start.session,
                &decode_blob(&ptm)?,
                &decode_blob(&tk)?,
                routing,
            )
            .ok()?;
            if adi.is_machine_provisioned(DS_ID).ok()?.ret != 0 {
                return None;
            }
        }
        _ => return None,
    }
    let result = adi.request_otp(DS_ID).ok()?;
    if !result.reply.ok() || result.mid.is_empty() || result.otp.is_empty() {
        return None;
    }
    let (_, routing) = adi.get_routing(DS_ID).ok()?;
    let store = adi
        .store_files()
        .into_iter()
        .filter(|(name, _)| store_file(name))
        .map(|(name, bytes)| (name, STANDARD.encode(bytes)))
        .collect();
    send(
        output,
        Reply::Headers {
            mid: STANDARD.encode(result.mid),
            otp: STANDARD.encode(result.otp),
            routing,
            store,
        },
    )
}

fn open_engine() -> Option<CoreAdi> {
    let mut args = env::args_os().skip(1);
    let library = args.next()?;
    if args.next().is_some() {
        return None;
    }
    let mut image = Vec::new();
    fs::File::open(library)
        .ok()?
        .take(LIBRARY_LIMIT + 1)
        .read_to_end(&mut image)
        .ok()?;
    if image.len() as u64 > LIBRARY_LIMIT {
        return None;
    }
    CoreAdi::new(&image).ok()
}

fn main() -> ExitCode {
    let (stdin, stdout) = (io::stdin(), io::stdout());
    if stdin.is_terminal() || stdout.is_terminal() {
        return ExitCode::FAILURE;
    }
    let mut output = stdout.lock();
    if open_engine()
        .and_then(|adi| run(adi, &mut stdin.lock(), &mut output))
        .is_some()
    {
        return ExitCode::SUCCESS;
    }
    let _ = send(&mut output, Reply::Error);
    ExitCode::FAILURE
}
