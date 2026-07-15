# OpenAgentPack Demo — AI Agent 的 Terraform
# Usage: vhs packages/sdk/docs/agents.tape  (run from project root)
#
# Prerequisites:
#   - Built CLI:           bun install && bun --filter @openagentpack/cli run build
#   - Bailian credentials in .env at repo root:
#       DASHSCOPE_API_KEY, BAILIAN_WORKSPACE_ID
#   (plan/apply/destroy/session run call the Bailian API; without credentials
#    those commands will fail — `cat`, `validate`, and `cd` still work for a
#    partial demo.)

Output packages/sdk/docs/agents.gif
Set Shell zsh
Set FontSize 16
Set Width 1200
Set Height 700
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 30ms
Set CursorBlink false

Sleep 200ms

# Load Bailian credentials and enter the example project, hidden so the demo
# starts directly at the agents.yaml contents — no paths or keys on screen.
Hide
Type "set -a; source .env; set +a"
Enter
Sleep 500ms
Type "cd examples/bailian/basic"
Enter
Sleep 500ms
Show

Type "cat agents.yaml"
Enter
Sleep 2500ms

Type "agents plan"
Enter
Sleep 2500ms

Type "agents apply -y"
Enter
Sleep 3000ms

Type 'agents session run "你好，你是什么模型？"'
Enter
Sleep 6000ms

Type "agents destroy -y"
Enter
Sleep 2500ms

Sleep 500ms
