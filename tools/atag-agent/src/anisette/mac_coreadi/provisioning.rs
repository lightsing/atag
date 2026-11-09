//! AuthKit's pre-authentication MidService exchange for a fresh emulated machine.
use super::{
    Identity, local,
    protocol::{self, Reply, Request},
    worker::{self, Worker},
};
use crate::{
    anisette::{apple_http_client, bounded_body, mid_service, network_error},
    error::ApiError,
    now,
};
use plist::{Dictionary, Value};
use reqwest::{Client, RequestBuilder, Url};

pub(super) async fn run(
    worker: &mut Worker,
    identity: &Identity,
) -> Result<(Reply, u64), ApiError> {
    let client = apple_http_client()?;
    let lookup = send(client.get(mid_service::LOOKUP), identity, "目录", None).await?;
    let urls = lookup
        .as_dictionary()
        .and_then(|value| value.get("urls"))
        .ok_or_else(|| local::failure("Apple 机器注册目录无效。"))?;
    let start = endpoint(urls, "midStartProvisioning")?;
    let finish = endpoint(urls, "midFinishProvisioning")?;

    let start = post(&client, start, identity, "开始注册", Dictionary::new()).await?;
    let spim = blob(&start, "spim")?;
    let Reply::Started { cpim } = worker.exchange(&Request::Provision { spim }).await? else {
        return Err(worker::failure());
    };
    if protocol::decode_blob(&cpim).is_none_or(|bytes| bytes.is_empty()) {
        return Err(worker::failure());
    }
    let request = Dictionary::from_iter([("cpim", Value::String(cpim))]);
    let finish = post(&client, finish, identity, "完成注册", request).await?;
    let routing = parse_routing(&finish)?;
    let reply = worker
        .exchange(&Request::Finish {
            ptm: blob(&finish, "ptm")?,
            tk: blob(&finish, "tk")?,
            routing,
        })
        .await?;
    Ok((reply, routing))
}

fn endpoint(urls: &Value, name: &str) -> Result<Url, ApiError> {
    let url = mid_service::apple_url(mid_service::plist_field(urls, name)?)?;
    if !url.path().starts_with("/grandslam/") {
        return Err(local::failure("Apple 机器注册地址不受支持。"));
    }
    Ok(url)
}

fn blob(response: &Value, name: &str) -> Result<String, ApiError> {
    let encoded = mid_service::plist_field(response, name)?;
    if protocol::decode_blob(encoded).is_none_or(|bytes| bytes.is_empty()) {
        return Err(local::failure("Apple 机器注册数据无效。"));
    }
    Ok(encoded.into())
}

fn parse_routing(response: &Value) -> Result<u64, ApiError> {
    let value = response
        .as_dictionary()
        .and_then(|d| d.get("X-Apple-I-MD-RINFO"));
    match value {
        None => Ok(0),
        Some(Value::String(text)) if text.is_empty() => Ok(0),
        Some(value) => value
            .as_unsigned_integer()
            .or_else(|| value.as_string()?.parse().ok())
            .ok_or_else(|| local::failure("Apple 机器注册路由值无效。")),
    }
}

async fn post(
    client: &Client,
    url: Url,
    identity: &Identity,
    stage: &str,
    request: Dictionary,
) -> Result<Value, ApiError> {
    let plist = Value::Dictionary(Dictionary::from_iter([
        ("Header", Value::Dictionary(Dictionary::new())),
        ("Request", Value::Dictionary(request)),
    ]));
    let mut bytes = Vec::new();
    plist
        .to_writer_xml(&mut bytes)
        .map_err(|_| ApiError::internal())?;
    let response = send(client.post(url), identity, stage, Some(bytes)).await?;
    response
        .into_dictionary()
        .and_then(|mut response| response.remove("Response"))
        .ok_or_else(|| local::failure("Apple 机器注册响应缺少必要字段。"))
}

async fn send(
    request: RequestBuilder,
    identity: &Identity,
    stage: &str,
    body: Option<Vec<u8>>,
) -> Result<Value, ApiError> {
    let mut request = request
        .header("User-Agent", "akd/1.0 CFNetwork/1404.0.5 Darwin/22.3.0")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Connection", "close")
        .header("Accept", "*/*")
        .header("X-Mme-Device-Id", &identity.device_id)
        .header("X-MMe-Client-Info", &identity.client_info)
        .header("X-Apple-I-MD-LU", &identity.local_user_uuid)
        .header("X-Apple-Client-App-Name", "Setup")
        .header("X-Apple-I-SRL-NO", &identity.serial);
    if let Some(body) = body {
        request = request.header("X-Apple-I-Client-Time", now()).body(body);
    }
    let response = request.send().await.map_err(network_error)?;
    if !response.status().is_success() {
        return Err(local::failure(&format!(
            "Apple 机器注册{stage}失败（HTTP {}）。",
            response.status().as_u16()
        )));
    }
    let bytes = bounded_body(response, protocol::BLOB_LIMIT).await?;
    Value::from_reader(std::io::Cursor::new(bytes))
        .map_err(|_| local::failure("Apple 机器注册响应无效。"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, body::Bytes, http::HeaderMap, routing::post as route_post};

    #[tokio::test]
    async fn provisioning_sends_the_authkit_plist_and_reads_routing() {
        let identity = Identity::new();
        let device_id = identity.device_id.clone();
        let local_user_uuid = identity.local_user_uuid.clone();
        let serial = identity.serial.clone();
        let app = Router::new().route(
            "/finish",
            route_post(move |headers: HeaderMap, body: Bytes| async move {
                assert_eq!(headers["x-mme-device-id"], device_id);
                assert_eq!(headers["x-apple-i-md-lu"], local_user_uuid);
                assert_eq!(headers["x-apple-i-srl-no"], serial);
                assert_eq!(headers["content-type"], "application/x-www-form-urlencoded");
                assert!(headers.contains_key("x-apple-i-client-time"));
                let plist = Value::from_reader(std::io::Cursor::new(body)).unwrap();
                let fields = plist.as_dictionary().unwrap();
                assert!(fields["Header"].as_dictionary().unwrap().is_empty());
                assert_eq!(
                    mid_service::plist_field(&fields["Request"], "cpim").unwrap(),
                    "AQI="
                );
                let reply = Value::Dictionary(Dictionary::from_iter([(
                    "Response",
                    Value::Dictionary(Dictionary::from_iter([
                        ("ptm", Value::String("AwQ=".into())),
                        ("tk", Value::String("BQY=".into())),
                        ("X-Apple-I-MD-RINFO", Value::String("17106176".into())),
                    ])),
                )]));
                let mut bytes = Vec::new();
                reply.to_writer_xml(&mut bytes).unwrap();
                bytes
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!("http://{}/finish", listener.local_addr().unwrap())).unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = Client::builder().no_proxy().build().unwrap();
        let reply = post(
            &client,
            url,
            &identity,
            "完成注册",
            Dictionary::from_iter([("cpim", Value::String("AQI=".into()))]),
        )
        .await
        .unwrap();
        server.abort();
        assert_eq!(blob(&reply, "ptm").unwrap(), "AwQ=");
        assert_eq!(blob(&reply, "tk").unwrap(), "BQY=");
        assert_eq!(parse_routing(&reply).unwrap(), 17_106_176);
    }
}
