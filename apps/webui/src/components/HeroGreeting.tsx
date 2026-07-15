import { useEffect, useRef, useState } from "react";
import type { RoleCard } from "@/lib/playbooks/types";

interface HeroGreetingProps {
	roleCards: RoleCard[];
	selectedRoleId?: string | null;
	onActiveIndexChange?: (index: number) => void;
}

const ROTATE_INTERVAL = 8000; // ms between switches

export default function HeroGreeting({ roleCards, selectedRoleId, onActiveIndexChange }: HeroGreetingProps) {
	const [rotationIndex, setRotationIndex] = useState(0);
	const onActiveIndexChangeRef = useRef(onActiveIndexChange);
	onActiveIndexChangeRef.current = onActiveIndexChange;

	const count = roleCards.length;
	const paused = !!selectedRoleId;

	// 自动轮播（未选中时）。计时器与暂停/数量绑定，卸载时清理。
	useEffect(() => {
		if (paused || count <= 1) return;
		const timer = setInterval(() => {
			setRotationIndex((prev) => (prev + 1) % count);
		}, ROTATE_INTERVAL);
		return () => clearInterval(timer);
	}, [paused, count]);

	// 当前展示的 index 直接由 props/轮播位推导，避免用 effect 同步 prop。
	const selectedIndex = selectedRoleId ? roleCards.findIndex((r) => r.slug === selectedRoleId) : -1;
	const displayIndex = selectedIndex >= 0 ? selectedIndex : count > 0 ? rotationIndex % count : 0;
	const displayRole = roleCards[displayIndex];

	// 通知父组件当前展示的 index 变化。
	useEffect(() => {
		onActiveIndexChangeRef.current?.(displayIndex);
	}, [displayIndex]);

	if (!displayRole) return null;

	return (
		<div className="greeting">
			<h1 id="hero-title" className="greeting-with-role">
				你身边的AI {/* key 触发重挂载，CSS 关键帧每次切换都重放淡入动画 */}
				<span key={displayRole.slug} className="greeting-role-name">
					「{displayRole.name}」
				</span>
			</h1>
		</div>
	);
}
