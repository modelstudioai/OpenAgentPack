import { RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { confirmDialog } from "@/lib/confirm-dialog";
import { deleteEnvironment } from "@/lib/domain/environment";
import type { ResourceEnvRow, ResourceVaultRow } from "@/lib/domain/resource-center";
import { deleteVault } from "@/lib/domain/vault";
import { useRc } from "../context";
import { fmtTime } from "../shared/formatters";

export function RuntimePanel() {
	const {
		view,
		loading,
		setError,
		updateView,
		refresh,
		refreshingEnv,
		refreshingVault,
		refreshEnvironments,
		refreshVaults,
	} = useRc();
	const [deletingEnvId, setDeletingEnvId] = useState<string | null>(null);
	const [deletingVaultId, setDeletingVaultId] = useState<string | null>(null);

	const baseEnv = view?.environments?.[0];
	const baseVault = view?.vaults?.[0];

	const handleDeleteEnvironment = useCallback(
		async (env: { id: string; name: string }) => {
			const ok = await confirmDialog({
				title: `删除运行环境「${env.name}」？`,
				message: `线上 ID ${env.id}。这是任务运行所在的 base 沙箱，删除后所有任务都将无法执行（下次创建任务会重新引导创建）。仍有任务依赖时云端会拒绝删除。此操作不可恢复。`,
				confirmText: "删除",
				danger: true,
			});
			if (!ok) return;
			setDeletingEnvId(env.id);
			setError(null);
			try {
				await deleteEnvironment(env.id);
			} catch (e) {
				setError(e instanceof Error ? e.message : "删除运行环境失败");
				return;
			} finally {
				setDeletingEnvId(null);
			}
			updateView((prev) => ({ ...prev, environments: prev.environments.filter((x) => x.id !== env.id) }));
			refresh();
		},
		[setError, updateView, refresh],
	);

	const handleDeleteVault = useCallback(
		async (vault: { id: string; name: string }) => {
			const ok = await confirmDialog({
				title: `删除密钥库「${vault.name}」？`,
				message: `线上 ID ${vault.id}。这是任务运行注入 DASHSCOPE_API_KEY 的 base 密钥库，删除后新任务将无法绑定该凭据（下次创建任务会重新引导创建）。此操作不可恢复。`,
				confirmText: "删除",
				danger: true,
			});
			if (!ok) return;
			setDeletingVaultId(vault.id);
			setError(null);
			try {
				await deleteVault(vault.id);
			} catch (e) {
				setError(e instanceof Error ? e.message : "删除密钥库失败");
				return;
			} finally {
				setDeletingVaultId(null);
			}
			updateView((prev) => ({ ...prev, vaults: prev.vaults.filter((x) => x.id !== vault.id) }));
			refresh();
		},
		[setError, updateView, refresh],
	);

	return (
		<div className="rc-infra-row">
			<section className="rc-panel" aria-label="运行环境">
				<div className="rc-panel-head">
					<div>
						<div className="rc-panel-title">运行环境(沙箱)</div>
						<div className="rc-panel-sub">本项目创建的 base 沙箱 · 任务运行所在</div>
					</div>
					<div className="rc-bulk-bar">
						{baseEnv ? <span className="rc-badge playbook">当前 base</span> : null}
						{baseEnv ? (
							<button
								className="icon-btn danger"
								type="button"
								aria-label="删除环境"
								title="删除环境"
								onClick={() => handleDeleteEnvironment({ id: baseEnv.id, name: baseEnv.name || "未命名" })}
								disabled={deletingEnvId === baseEnv.id}
							>
								<Trash2 size={14} aria-hidden="true" />
							</button>
						) : null}
						<button
							className="icon-btn"
							type="button"
							aria-label="刷新环境"
							title="刷新环境"
							onClick={() => void refreshEnvironments()}
							disabled={loading || refreshingEnv}
						>
							<RefreshCw size={14} aria-hidden="true" className={loading || refreshingEnv ? "rc-spin" : undefined} />
						</button>
					</div>
				</div>
				{baseEnv ? <EnvironmentCard env={baseEnv} /> : null}
				{!loading && view && !baseEnv ? (
					<div className="rc-empty">
						<div className="rc-empty-title">暂无运行环境</div>
						<div className="rc-empty-desc">尚未检测到受管 base 沙箱,首个任务创建时会引导创建。</div>
					</div>
				) : null}
				{loading && !view ? (
					<div className="rc-detail-body">
						<span className="rc-skeleton" />
					</div>
				) : null}
			</section>

			<section className="rc-panel" aria-label="密钥库">
				<div className="rc-panel-head">
					<div>
						<div className="rc-panel-title">密钥库(Vault)</div>
						<div className="rc-panel-sub">本项目创建的 base 密钥库 · 持有 DASHSCOPE_API_KEY</div>
					</div>
					<div className="rc-bulk-bar">
						{baseVault ? <span className="rc-badge playbook">当前 base</span> : null}
						{baseVault ? (
							<button
								className="icon-btn danger"
								type="button"
								aria-label="删除密钥库"
								title="删除密钥库"
								onClick={() => handleDeleteVault({ id: baseVault.id, name: baseVault.name || "未命名" })}
								disabled={deletingVaultId === baseVault.id}
							>
								<Trash2 size={14} aria-hidden="true" />
							</button>
						) : null}
						<button
							className="icon-btn"
							type="button"
							aria-label="刷新密钥库"
							title="刷新密钥库"
							onClick={() => void refreshVaults()}
							disabled={loading || refreshingVault}
						>
							<RefreshCw size={14} aria-hidden="true" className={loading || refreshingVault ? "rc-spin" : undefined} />
						</button>
					</div>
				</div>
				{baseVault ? <VaultCard vault={baseVault} /> : null}
				{!loading && view && !baseVault ? (
					<div className="rc-empty">
						<div className="rc-empty-title">暂无密钥库</div>
						<div className="rc-empty-desc">本地模式下沙箱密钥由服务端提供;控制台模式下首个任务创建时会引导填写。</div>
					</div>
				) : null}
				{loading && !view ? (
					<div className="rc-detail-body">
						<span className="rc-skeleton" />
					</div>
				) : null}
			</section>
		</div>
	);
}

function EnvironmentCard({ env }: { env: ResourceEnvRow }) {
	return (
		<div className="rc-detail-body rc-env-current">
			<div>
				<h2>{env.name || "未命名"}</h2>
				{env.description ? <p>{env.description}</p> : null}
			</div>
			<div className="rc-info-grid">
				<div className="rc-info-key">网络 / 运行时</div>
				<div className={`rc-info-value${env.networking ? "" : " rc-dim"}`}>
					{env.networking ?? "—"}
					{env.packages.length ? (
						<>
							{" · "}
							<span className="rc-mono">{env.packages.join(", ")}</span>
						</>
					) : null}
				</div>
				<div className="rc-info-key">更新</div>
				<div className="rc-info-value">{fmtTime(env.updatedAt)}</div>
				<div className="rc-info-key">线上 ID</div>
				<div className="rc-info-value rc-mono">{env.id}</div>
			</div>
		</div>
	);
}

function VaultCard({ vault }: { vault: ResourceVaultRow }) {
	return (
		<div className="rc-detail-body rc-env-current">
			<div>
				<h2>{vault.name || "未命名"}</h2>
			</div>
			<div className="rc-info-grid">
				<div className="rc-info-key">凭据</div>
				<div className="rc-info-value rc-mono">DASHSCOPE_API_KEY</div>
				<div className="rc-info-key">更新</div>
				<div className="rc-info-value">{fmtTime(vault.updatedAt)}</div>
				<div className="rc-info-key">线上 ID</div>
				<div className="rc-info-value rc-mono">{vault.id}</div>
			</div>
		</div>
	);
}
