use crate::domain::models::{PortForwardingDraft, PortForwardingRule};
use crate::usecases::connection_usecase::{clean_text, unix_time};

pub fn create(draft: PortForwardingDraft, id: String) -> PortForwardingRule {
    let now = unix_time();
    PortForwardingRule {
        id,
        name: clean_text(draft.name),
        tags: draft.tags.into_iter().map(clean_text).filter(|tag| !tag.is_empty()).collect(),
        group: clean_text(draft.group),
        rule_type: "Local".to_string(),
        host_id: draft.host_id,
        bind_address: clean_text(draft.bind_address),
        bind_port: draft.bind_port,
        target_address: clean_text(draft.target_address),
        target_port: draft.target_port,
        created_at: now,
        updated_at: now,
    }
}

pub fn update(rule: &mut PortForwardingRule, draft: PortForwardingDraft) {
    let now = unix_time();
    rule.name = clean_text(draft.name);
    rule.tags = draft.tags.into_iter().map(clean_text).filter(|tag| !tag.is_empty()).collect();
    rule.group = clean_text(draft.group);
    rule.rule_type = "Local".to_string();
    rule.host_id = draft.host_id;
    rule.bind_address = clean_text(draft.bind_address);
    rule.bind_port = draft.bind_port;
    rule.target_address = clean_text(draft.target_address);
    rule.target_port = draft.target_port;
    rule.updated_at = now;
}

pub fn local_forward_spec(rule: &PortForwardingRule) -> String {
    let bind_port = rule.bind_port.unwrap_or(0);
    let target_port = rule.target_port.unwrap_or(0);
    let bind_address = rule.bind_address.trim();

    if bind_address.is_empty() || bind_address == "127.0.0.1" || bind_address.eq_ignore_ascii_case("localhost") {
        format!("{}:{}:{}", bind_port, rule.target_address, target_port)
    } else {
        format!("{}:{}:{}:{}", bind_address, bind_port, rule.target_address, target_port)
    }
}
