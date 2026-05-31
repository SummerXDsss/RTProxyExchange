//! Unit tests for core conversion logic.

use crate::builder::{build_codex_account, generate_account_id};
use crate::input::{
    find_refresh_token, is_codex_oauth_account, looks_like_sub2api_export, parse_input,
};
use crate::jwt::{decode_payload, extract_user_info};
use crate::models::TokenResponse;
use base64::Engine;
use serde_json::json;

/// Build a JWT-like string with the given JSON payload (header/sig are dummy).
fn make_jwt(payload: serde_json::Value) -> String {
    let header = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b"{\"alg\":\"none\"}");
    let body = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&payload).unwrap());
    format!("{header}.{body}.sig")
}

#[test]
fn decode_payload_extracts_claims() {
    let jwt = make_jwt(json!({ "email": "a@b.com", "sub": "user-1" }));
    let payload = decode_payload(&jwt).unwrap();
    assert_eq!(payload["email"], "a@b.com");
    assert_eq!(payload["sub"], "user-1");
}

#[test]
fn decode_payload_rejects_malformed() {
    assert!(decode_payload("not-a-jwt").is_err());
}

#[test]
fn extract_user_info_from_id_token() {
    let id_token = make_jwt(json!({
        "email": "user@example.com",
        "https://api.openai.com/auth": {
            "chatgpt_account_id": "account-xxx",
            "chatgpt_user_id": "user-xxx",
            "chatgpt_plan_type": "plus",
            "poid": "org-xxx"
        }
    }));
    let access_token = make_jwt(json!({ "exp": 1_900_000_000i64 }));
    let tokens = TokenResponse {
        access_token,
        id_token,
        refresh_token: "v1.new".into(),
        expires_in: 3600,
        token_type: "Bearer".into(),
        scope: "openid".into(),
    };

    let info = extract_user_info(&tokens);
    assert_eq!(info.email.as_deref(), Some("user@example.com"));
    assert_eq!(info.account_id.as_deref(), Some("account-xxx"));
    assert_eq!(info.user_id.as_deref(), Some("user-xxx"));
    assert_eq!(info.plan_type.as_deref(), Some("plus"));
    assert_eq!(info.organization_id.as_deref(), Some("org-xxx"));
    assert_eq!(info.expires_at, Some(1_900_000_000));
}

#[test]
fn account_id_is_stable_and_unique() {
    let a = generate_account_id(Some("a@b.com"), Some("acc"), Some("org"));
    let b = generate_account_id(Some("a@b.com"), Some("acc"), Some("org"));
    let c = generate_account_id(Some("x@y.com"), Some("acc"), Some("org"));
    assert_eq!(a, b);
    assert_ne!(a, c);
    assert_eq!(a.len(), 64); // sha256 hex
}

#[test]
fn build_account_preserves_old_refresh_when_empty() {
    let tokens = TokenResponse {
        access_token: "at".into(),
        id_token: "it".into(),
        refresh_token: "  ".into(), // empty/whitespace
        expires_in: 3600,
        token_type: "Bearer".into(),
        scope: String::new(),
    };
    let info = Default::default();
    let account = build_codex_account("v1.original", &tokens, &info);
    assert_eq!(account.tokens.refresh_token, "v1.original");
    assert_eq!(account.auth_mode, "oauth");
    assert_eq!(account.api_provider_mode, "openai_builtin");
    assert_eq!(account.token_source_mode, "managed");
}

#[test]
fn find_refresh_token_priority() {
    // direct
    let v = json!({ "refresh_token": "rt1" });
    assert_eq!(find_refresh_token(&v).as_deref(), Some("rt1"));
    // camelCase
    let v = json!({ "refreshToken": "rt2" });
    assert_eq!(find_refresh_token(&v).as_deref(), Some("rt2"));
    // nested credentials
    let v = json!({ "credentials": { "refresh_token": "rt3" } });
    assert_eq!(find_refresh_token(&v).as_deref(), Some("rt3"));
    // nested tokens
    let v = json!({ "tokens": { "refreshToken": "rt4" } });
    assert_eq!(find_refresh_token(&v).as_deref(), Some("rt4"));
}

#[test]
fn parse_input_plain_and_batch() {
    assert_eq!(parse_input("v1.single").unwrap(), vec!["v1.single"]);
    let batch = "v1.a\nv1.b\n\n# comment\nv1.c";
    assert_eq!(parse_input(batch).unwrap(), vec!["v1.a", "v1.b", "v1.c"]);
}

#[test]
fn parse_input_custom_json() {
    let input = r#"{"refresh_token": "v1.json"}"#;
    assert_eq!(parse_input(input).unwrap(), vec!["v1.json"]);
}

#[test]
fn parse_input_sub2api_export() {
    let export = json!({
        "exported_at": "2026-04-18T12:00:00Z",
        "accounts": [
            { "platform": "openai", "type": "oauth", "credentials": { "refresh_token": "v1.codex" } },
            { "platform": "anthropic", "type": "oauth", "credentials": { "refresh_token": "v1.other" } }
        ]
    });
    let tokens = parse_input(&export.to_string()).unwrap();
    assert_eq!(tokens, vec!["v1.codex"]);
}

#[test]
fn parse_input_json_array() {
    let input = r#"["v1.x", {"refresh_token": "v1.y"}]"#;
    assert_eq!(parse_input(input).unwrap(), vec!["v1.x", "v1.y"]);
}

#[test]
fn sub2api_detection() {
    let export = json!({ "exported_at": "now", "accounts": [] });
    assert!(looks_like_sub2api_export(&export));
    let plain = json!({ "refresh_token": "x" });
    assert!(!looks_like_sub2api_export(&plain));
}

#[test]
fn codex_oauth_detection() {
    assert!(is_codex_oauth_account(
        &json!({ "platform": "openai", "type": "oauth" })
    ));
    assert!(!is_codex_oauth_account(
        &json!({ "platform": "anthropic", "type": "oauth" })
    ));
}

#[test]
fn parse_input_empty_errors() {
    assert!(parse_input("   ").is_err());
}

#[test]
fn file_config_applies_overrides() {
    use crate::config::RefreshConfig;
    use crate::file_config::FileConfig;

    let json = serde_json::json!({
        "oauth": { "client_id": "custom-id", "timeout": 50 },
        "network": { "max_retries": 5, "concurrency": 8 }
    });
    let cfg: FileConfig = serde_json::from_value(json).unwrap();
    let applied = cfg.apply_to(RefreshConfig::default());

    assert_eq!(applied.client_id, "custom-id");
    assert_eq!(applied.timeout_secs, 50);
    assert_eq!(applied.max_retries, 5);
    assert_eq!(applied.concurrency, 8);
    // Untouched fields keep defaults.
    assert_eq!(applied.scope, crate::config::DEFAULT_SCOPE);
}

#[test]
fn file_config_empty_keeps_defaults() {
    use crate::config::RefreshConfig;
    use crate::file_config::FileConfig;

    let cfg: FileConfig = serde_json::from_str("{}").unwrap();
    let base = RefreshConfig::default();
    let applied = cfg.apply_to(base.clone());
    assert_eq!(applied.client_id, base.client_id);
    assert_eq!(applied.timeout_secs, base.timeout_secs);
}

#[test]
fn sub2api_to_cpa_maps_fields() {
    use crate::transform::sub2api_json_to_cpa;

    let export = serde_json::json!({
        "exported_at": "2026-04-18T12:00:00Z",
        "proxies": [],
        "accounts": [{
            "name": "u@example.com",
            "platform": "openai",
            "type": "oauth",
            "credentials": {
                "access_token": "at",
                "expires_at": "2026-06-06T05:28:57.000Z",
                "refresh_token": "rt_abc",
                "id_token": "it",
                "email": "u@example.com",
                "chatgpt_account_id": "account-1",
                "chatgpt_user_id": "user-1",
                "plan_type": "plus"
            },
            "concurrency": 0,
            "priority": 0
        }],
        "type": "subdata",
        "version": 1
    });

    let accounts = sub2api_json_to_cpa(&export.to_string()).unwrap();
    assert_eq!(accounts.len(), 1);
    let acc = &accounts[0];
    assert_eq!(acc.email.as_deref(), Some("u@example.com"));
    assert_eq!(acc.account_id.as_deref(), Some("account-1"));
    assert_eq!(acc.refresh_token, "rt_abc");
    assert_eq!(acc.id_token, "it");
    assert_eq!(acc.kind, "codex");
    assert_eq!(acc.expired.as_deref(), Some("2026-06-06T05:28:57.000Z"));
}

#[test]
fn cpa_to_sub2api_maps_fields() {
    use crate::transform::cpa_json_to_sub2api;

    let cpa = serde_json::json!([{
        "id_token": "it",
        "access_token": "at",
        "refresh_token": "rt_abc",
        "account_id": "account-1",
        "email": "u@example.com",
        "type": "codex",
        "expired": "2026-06-06T05:28:57.000Z"
    }]);

    let export = cpa_json_to_sub2api(&cpa.to_string()).unwrap();
    assert_eq!(export.accounts.len(), 1);
    assert_eq!(export.kind, "subdata");
    assert_eq!(export.version, 1);
    let a = &export.accounts[0];
    assert_eq!(a.platform, "openai");
    assert_eq!(a.kind, "oauth");
    assert_eq!(a.name.as_deref(), Some("u@example.com"));
    assert_eq!(a.credentials.refresh_token, "rt_abc");
    assert_eq!(
        a.credentials.chatgpt_account_id.as_deref(),
        Some("account-1")
    );
    assert_eq!(
        a.credentials.expires_at.as_deref(),
        Some("2026-06-06T05:28:57.000Z")
    );
}

#[test]
fn cpa_sub2api_round_trip_preserves_core_fields() {
    use crate::transform::{cpa_accounts_to_sub2api, sub2api_export_to_cpa, CpaAccount};

    let original = CpaAccount {
        id_token: "it".into(),
        access_token: "at".into(),
        refresh_token: "rt_abc".into(),
        account_id: Some("account-1".into()),
        last_refresh: Some("2026-05-27T13:25:50.000Z".into()),
        email: Some("u@example.com".into()),
        kind: "codex".into(),
        expired: Some("2026-06-06T05:28:57.000Z".into()),
    };

    let export = cpa_accounts_to_sub2api(std::slice::from_ref(&original));
    let back = sub2api_export_to_cpa(&export);

    assert_eq!(back.len(), 1);
    let rt = &back[0];
    assert_eq!(rt.email, original.email);
    assert_eq!(rt.account_id, original.account_id);
    assert_eq!(rt.refresh_token, original.refresh_token);
    assert_eq!(rt.id_token, original.id_token);
    assert_eq!(rt.expired, original.expired);
}

#[test]
fn parse_cpa_accepts_object_array_and_sub2api() {
    use crate::transform::parse_cpa_accounts;

    let bare = r#"{"refresh_token":"r","email":"a@b.com"}"#;
    assert_eq!(parse_cpa_accounts(bare).unwrap().len(), 1);

    let array = r#"[{"refresh_token":"r1"},{"refresh_token":"r2"}]"#;
    assert_eq!(parse_cpa_accounts(array).unwrap().len(), 2);

    let sub2api = r#"{"exported_at":"x","accounts":[{"platform":"openai","type":"oauth","credentials":{"refresh_token":"r"}}],"version":1}"#;
    let parsed = parse_cpa_accounts(sub2api).unwrap();
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].refresh_token, "r");
}

#[test]
fn split_accounts_names_and_dual_format() {
    use crate::transform::split_accounts;

    let input = serde_json::json!([
        { "refresh_token": "r1", "email": "alice@example.com", "account_id": "acc-1" },
        { "refresh_token": "r2", "email": "bob+test@example.com" }
    ]);

    let result = split_accounts(&input.to_string()).unwrap();
    assert_eq!(result.total, 2);

    let a0 = &result.accounts[0];
    assert_eq!(a0.email.as_deref(), Some("alice@example.com"));
    assert_eq!(a0.filename_base, "codex_alice@example.com");
    assert_eq!(a0.cpa.refresh_token, "r1");
    assert_eq!(a0.sub2api.accounts.len(), 1);
    assert_eq!(a0.sub2api.kind, "subdata");

    // '+' is sanitized to '_'.
    let a1 = &result.accounts[1];
    assert_eq!(a1.filename_base, "codex_bob_test@example.com");
}

#[test]
fn filename_base_fallbacks() {
    use crate::transform::filename_base;
    assert_eq!(filename_base(Some("a@b.com"), None, 0), "codex_a@b.com");
    assert_eq!(filename_base(None, Some("acc-1"), 0), "codex_acc-1");
    assert_eq!(filename_base(None, None, 3), "codex_account_3");
}

#[test]
fn parse_free_account_format() {
    use crate::transform::{parse_cpa_accounts, split_accounts};

    // Free-号 format: top-level version + chatgpt_account_id (not account_id),
    // plus many extra fields that must be ignored.
    let free = serde_json::json!({
        "version": 1,
        "db_id": 70994,
        "platform": "chatgpt",
        "email": "free@example.com",
        "password": "secret",
        "access_token": "at",
        "refresh_token": "rt_free",
        "id_token": "it",
        "client_id": "app_x",
        "chatgpt_account_id": "acc-free",
        "chatgpt_user_id": "user-free",
        "organization_id": "org-free",
        "mailbox": { "provider": "microsoft" }
    });

    let accounts = parse_cpa_accounts(&free.to_string()).unwrap();
    assert_eq!(accounts.len(), 1);
    let a = &accounts[0];
    assert_eq!(a.email.as_deref(), Some("free@example.com"));
    assert_eq!(a.refresh_token, "rt_free");
    // chatgpt_account_id is read into account_id via serde alias.
    assert_eq!(a.account_id.as_deref(), Some("acc-free"));

    // Split produces both formats with chatgpt fields populated.
    let result = split_accounts(&free.to_string()).unwrap();
    assert_eq!(result.total, 1);
    let s = &result.accounts[0];
    assert_eq!(
        s.sub2api.accounts[0]
            .credentials
            .chatgpt_account_id
            .as_deref(),
        Some("acc-free")
    );
    assert_eq!(s.sub2api.accounts[0].credentials.refresh_token, "rt_free");
}
