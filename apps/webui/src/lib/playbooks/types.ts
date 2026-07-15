export type {
	AgentSkillResource,
	McpResource,
	PlaybookBundle,
	PlaybookTemplate,
	ResolvedMcpServer,
	ResolvedPlaybook,
	ResolvedSkill,
	ResourceOrigin,
} from "@openagentpack/playbooks";

// View-model the homepage consumes; visual components still use the role-card shape,
// but the identifier is now a playbook id.
export interface RoleCard {
	slug: string;
	name: string;
	prompt: string;
	imageUrl?: string;
	playbookTemplateId: string;
}
