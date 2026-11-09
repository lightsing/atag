use atag_agent::{
    error::ApiError,
    server::{AgentServer, ServerConfig},
};
use std::{io, net::SocketAddr, thread, time::Duration};
use tokio::sync::oneshot;

const DRAIN_TIMEOUT: Duration = Duration::from_secs(3);

pub enum Event {
    Started(SocketAddr),
    Finished(Result<(), String>),
}

pub fn start(
    config: ServerConfig,
    notify: impl Fn(Event) + Send + 'static,
) -> io::Result<oneshot::Sender<()>> {
    let (stop, stopped) = oneshot::channel();
    thread::Builder::new()
        .name("atag-agent".into())
        .spawn(move || {
            let result = run(config, stopped, &notify).map_err(|error| error.to_string());
            notify(Event::Finished(result));
        })?;
    Ok(stop)
}

fn run(
    config: ServerConfig,
    mut stop: oneshot::Receiver<()>,
    notify: &impl Fn(Event),
) -> Result<(), ApiError> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    let result = runtime.block_on(async {
        let server = tokio::select! {
            _ = &mut stop => return Ok(()),
            server = AgentServer::bind(config) => server?,
        };
        notify(Event::Started(server.local_addr()));
        let (drain, shutdown) = oneshot::channel();
        let serve = server.serve(async move {
            let _ = shutdown.await;
        });
        tokio::pin!(serve);
        tokio::select! {
            result = &mut serve => result,
            _ = stop => {
                let _ = drain.send(());
                tokio::time::timeout(DRAIN_TIMEOUT, serve).await.unwrap_or(Ok(()))
            }
        }
    });
    // Axum owns per-connection tasks on this runtime. Dropping it cancels requests that outlive
    // the drain budget and lets their isolated Anisette processes be killed before a restart.
    runtime.shutdown_timeout(Duration::from_secs(1));
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpStream,
        sync::mpsc,
    };

    const WAIT: Duration = Duration::from_secs(8);

    fn launch(config: ServerConfig) -> (oneshot::Sender<()>, mpsc::Receiver<Event>) {
        let (tx, rx) = mpsc::channel();
        let stop = start(config, move |event| {
            let _ = tx.send(event);
        })
        .unwrap();
        (stop, rx)
    }

    fn started(events: &mpsc::Receiver<Event>) -> SocketAddr {
        match events.recv_timeout(WAIT).unwrap() {
            Event::Started(address) => address,
            Event::Finished(result) => panic!("bridge exited before starting: {result:?}"),
        }
    }

    fn stop(stop: oneshot::Sender<()>, events: mpsc::Receiver<Event>) {
        stop.send(()).unwrap();
        assert!(matches!(
            events.recv_timeout(WAIT).unwrap(),
            Event::Finished(Ok(()))
        ));
    }

    #[test]
    fn bridge_serves_health_and_releases_the_port_for_restart() {
        let directory = tempfile::tempdir().unwrap();
        let mut config = ServerConfig {
            listen: Some("127.0.0.1:0".parse().unwrap()),
            data_dir: Some(directory.path().into()),
            ..ServerConfig::default()
        };
        let (stop_first, events) = launch(config.clone());
        let address = started(&events);
        let mut client = TcpStream::connect_timeout(&address, WAIT).unwrap();
        client.set_read_timeout(Some(WAIT)).unwrap();
        write!(client, "GET /v1/health HTTP/1.1\r\nHost: {address}\r\nOrigin: http://localhost:5173\r\nConnection: close\r\n\r\n").unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(response.contains("\"protocolVersion\":1"));
        config.listen = Some(address);

        let (_stop_conflict, conflict_events) = launch(config.clone());
        let Event::Finished(Err(error)) = conflict_events.recv_timeout(WAIT).unwrap() else {
            panic!("an occupied port should report a bind error");
        };
        assert!(error.contains("已被占用"));
        stop(stop_first, events);
        let (stop_next, events) = launch(config);
        assert_eq!(started(&events), address);
        stop(stop_next, events);
        assert_eq!(directory.path().read_dir().unwrap().count(), 0);
    }
}
