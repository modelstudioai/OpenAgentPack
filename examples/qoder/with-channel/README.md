# Qoder credential-based Channel

This example declares a Forward Identity, Forward Template, and DingTalk Channel without copying remote Qoder ids.

Set `QODER_PAT`, `SUPPORT_USER_ID`, `DINGTALK_CLIENT_ID`, and `DINGTALK_CLIENT_SECRET`, then run:

```bash
agents plan
agents apply
```

For Feishu, set `type: feishu` and use `app_id` / `app_secret`. For WeCom, set `type: wecom` and use `bot_id` / `secret`. Personal WeChat requires QR binding and is outside this credential-based workflow.
