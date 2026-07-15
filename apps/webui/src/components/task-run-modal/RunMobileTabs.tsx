import type { MobileTab } from "./types";

interface RunMobileTabsProps {
	mobileTab: MobileTab;
	onTabChange: (tab: MobileTab) => void;
}

/** 移动端产物/对话 Tab 切换 */
export function RunMobileTabs({ mobileTab, onTabChange }: RunMobileTabsProps) {
	return (
		<div className="run-mobile-tabs">
			<button
				type="button"
				className={`run-mobile-tab ${mobileTab === "product" ? "active" : ""}`}
				onClick={() => onTabChange("product")}
			>
				产物
			</button>
			<button
				type="button"
				className={`run-mobile-tab ${mobileTab === "chat" ? "active" : ""}`}
				onClick={() => onTabChange("chat")}
			>
				对话
			</button>
		</div>
	);
}
