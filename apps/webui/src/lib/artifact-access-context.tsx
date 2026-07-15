import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { ArtifactExpiredDialog } from "@/components/ArtifactExpiredDialog";
import { isArtifactUrlExpired } from "@/lib/artifact-url-expiry";

type ArtifactAccessContextValue = {
	isUrlExpired: (url: string) => boolean;
	tryOpenUrl: (url: string, fileName: string) => void;
	promptRegenerate: (url: string, fileName: string) => void;
};

const ArtifactAccessContext = createContext<ArtifactAccessContextValue | null>(null);

export function useArtifactAccess(): ArtifactAccessContextValue | null {
	return useContext(ArtifactAccessContext);
}

type ArtifactAccessProviderProps = {
	children: ReactNode;
	onRegenerate: (fileName: string) => void | Promise<void>;
	regenerateBusy?: boolean;
};

export function ArtifactAccessProvider({
	children,
	onRegenerate,
	regenerateBusy = false,
}: ArtifactAccessProviderProps) {
	const [pending, setPending] = useState<{ fileName: string } | null>(null);

	const promptRegenerate = useCallback((_url: string, fileName: string) => {
		setPending({ fileName });
	}, []);

	const tryOpenUrl = useCallback(
		(url: string, fileName: string) => {
			if (isArtifactUrlExpired(url)) {
				promptRegenerate(url, fileName);
				return;
			}
			window.open(url, "_blank", "noopener,noreferrer");
		},
		[promptRegenerate],
	);

	const value = useMemo<ArtifactAccessContextValue>(
		() => ({
			isUrlExpired: isArtifactUrlExpired,
			tryOpenUrl,
			promptRegenerate,
		}),
		[tryOpenUrl, promptRegenerate],
	);

	const handleConfirm = () => {
		if (!pending) return;
		void Promise.resolve(onRegenerate(pending.fileName)).finally(() => setPending(null));
	};

	return (
		<ArtifactAccessContext.Provider value={value}>
			{children}
			{pending && (
				<ArtifactExpiredDialog
					fileName={pending.fileName}
					busy={regenerateBusy}
					onConfirm={handleConfirm}
					onCancel={() => setPending(null)}
				/>
			)}
		</ArtifactAccessContext.Provider>
	);
}
