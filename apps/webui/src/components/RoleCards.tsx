import { useState } from "react";
import type { RoleCard } from "@/lib/playbooks/types";

interface RoleCardsProps {
	roleCards: RoleCard[];
	selectedId: string | null;
	onSelect: (id: string | null) => void;
	highlightedIndex?: number;
}

export default function RoleCards({ roleCards, selectedId, onSelect, highlightedIndex = 0 }: RoleCardsProps) {
	const [hoverId, setHoverId] = useState<string | null>(null);
	const [loadedImages, setLoadedImages] = useState<Set<string>>(new Set());

	const handleImageLoad = (id: string) => {
		setLoadedImages((prev) => new Set(prev).add(id));
	};
	const total = roleCards.length;
	const half = Math.floor(total / 2);
	// 相邻卡片间距
	const step = 104;
	// 每背离中心一格，多旋转 8 度（外翻）
	const tiltUnit = 8;

	return (
		<fieldset className="role-fan" onMouseLeave={() => setHoverId(null)}>
			<legend className="role-fan-legend">选择你的 AI 角色</legend>
			<div className="role-fan-track">
				{roleCards.map((role, idx) => {
					// 以 highlightedIndex 为中心计算偏移（取最短路径环绕）
					let offset = idx - highlightedIndex;
					if (offset > half) offset -= total;
					if (offset < -half) offset += total;
					const abs = Math.abs(offset);
					// 取反：下一张(offset>0)放在左边，上一张(offset<0)放在右边
					// 这样 index 递增时，卡片整体往右流动
					const translateX = -offset * step;
					// 外侧卡轻微下沉
					const lift = abs * 4;
					// 外翻方向也要跟随：左边(tx<0)逆时针，右边(tx>0)顺时针
					const rotate = offset === 0 ? 0 : -Math.sign(offset) * abs * tiltUnit;
					// 外侧尺寸递减
					const scale = 1 - abs * 0.04;
					const isSelected = selectedId === role.slug;
					const isHighlighted = !selectedId && highlightedIndex === idx;
					const isHover = hoverId === role.slug;
					const isActive = isSelected || isHighlighted || isHover;
					const roleImage = role.imageUrl;

					return (
						<button
							key={role.slug}
							type="button"
							className={`role-card ${isSelected ? "selected" : ""} ${isHighlighted ? "highlighted" : ""} ${
								isHover ? "hover" : ""
							}`}
							aria-pressed={isSelected}
							aria-label={role.name}
							onMouseEnter={() => setHoverId(role.slug)}
							onClick={() => onSelect(isSelected ? null : role.slug)}
							style={
								{
									"--tx": `${translateX}px`,
									"--tilt": `${rotate}deg`,
									"--lift": `${lift}px`,
									"--scale": `${scale}`,
									zIndex: isActive ? 100 : 50 - abs,
								} as React.CSSProperties
							}
						>
							<span className="role-name">{role.name}</span>
							<span className="role-photo">
								{roleImage && (
									<>
										{!loadedImages.has(role.slug) && <span className="role-photo-skeleton" />}
										<img
											src={roleImage}
											alt={role.name}
											draggable={false}
											className={loadedImages.has(role.slug) ? "loaded" : ""}
											onLoad={() => handleImageLoad(role.slug)}
										/>
									</>
								)}
							</span>
						</button>
					);
				})}
			</div>
		</fieldset>
	);
}
