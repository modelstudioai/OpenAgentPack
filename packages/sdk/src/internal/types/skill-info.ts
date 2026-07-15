export interface ProviderSkillInfo {
	id: string;
	name: string;
	description?: string;
	source: "custom" | "official";
	status: "checking" | "active" | "rejected" | "deleted";
	latest_version?: string;
	created_at?: string;
	updated_at?: string;
}
