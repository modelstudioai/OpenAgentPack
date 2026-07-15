import type { IdentityStamp } from "@/lib/domain/resource-center";
import { IDENTITY_LABEL } from "./badges";

export function IdentityBadge({ identity }: { identity: IdentityStamp }) {
	return <span className={`rc-badge ${identity}`}>{IDENTITY_LABEL[identity]}</span>;
}
