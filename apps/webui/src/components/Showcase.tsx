import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getShowcase } from "@/lib/playbooks";
import type { ShowcaseCard } from "@/lib/showcase-types";
import { useProviderConfigRevision } from "@/lib/store/provider-config-store";
import CaseDetailModal from "./CaseDetailModal";
import MasonryCard from "./MasonryCard";

const fixedHeights = [200, 240, 280, 220, 260, 300];

interface ShowcaseProps {
	onMakeSame: (input: { prompt: string; agentId?: string }) => void;
}

export default function Showcase({ onMakeSame }: ShowcaseProps) {
	const [activeTab, setActiveTab] = useState("all");
	const [showcase, setShowcase] = useState<{ categories: { key: string; label: string }[]; cards: ShowcaseCard[] }>({
		categories: [],
		cards: [],
	});
	const [loadCount, setLoadCount] = useState(0);
	const [modalCard, setModalCard] = useState<ShowcaseCard | null>(null);
	const loadMoreRef = useRef<HTMLDivElement>(null);
	// Seed pool for "load more"; held in a ref so the createMoreCards closure sees it
	// without re-creating the callback when async-loaded data arrives.
	const initialCardsRef = useRef<ShowcaseCard[]>([]);
	const maxLoads = 5;
	const allLoaded = loadCount >= maxLoads;
	const providerRevision = useProviderConfigRevision();

	const categoryKeys = useMemo(
		() => showcase.categories.flatMap((c) => (c.key === "all" ? [] : [c.key])),
		[showcase.categories],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: providerRevision 触发 showcase 按新渠道重拉
	useEffect(() => {
		let alive = true;
		void getShowcase().then((data) => {
			if (!alive) return;
			initialCardsRef.current = data.cards;
			setShowcase({ categories: data.categories, cards: data.cards });
			setLoadCount(0);
			setModalCard(null);
		});
		return () => {
			alive = false;
		};
	}, [providerRevision]);

	const createMoreCards = useCallback(
		(count: number): ShowcaseCard[] => {
			const source = initialCardsRef.current;
			if (source.length === 0 || categoryKeys.length === 0) return [];
			const newCards: ShowcaseCard[] = [];
			for (let i = 0; i < count; i++) {
				const pick = source[Math.floor(Math.random() * source.length)];
				if (!pick?.media) continue;
				newCards.push({
					...pick,
					category: categoryKeys[Math.floor(Math.random() * categoryKeys.length)]!,
					height: fixedHeights[Math.floor(Math.random() * fixedHeights.length)]!,
					imageId: Math.floor(Math.random() * 900 + 100),
				});
			}
			return newCards;
		},
		[categoryKeys],
	);

	useEffect(() => {
		// 等首屏案例加载完成后再挂 IntersectionObserver，避免 source 为空时生成无 media 的卡片
		if (!loadMoreRef.current || allLoaded || showcase.cards.length === 0) return;

		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0].isIntersecting && loadCount < maxLoads) {
					const more = createMoreCards(4);
					if (more.length === 0) return;
					setShowcase((prev) => ({ ...prev, cards: [...prev.cards, ...more] }));
					setLoadCount((prev) => prev + 1);
				}
			},
			{ rootMargin: "200px" },
		);

		observer.observe(loadMoreRef.current);
		return () => observer.disconnect();
	}, [loadCount, allLoaded, createMoreCards, showcase.cards.length]);

	return (
		<section className="showcase">
			<h2 className="showcase-title">更多案例</h2>
			<div className="showcase-header">
				<div className="showcase-tabs">
					{showcase.categories.map((cat) => (
						<button
							key={cat.key}
							type="button"
							className={`showcase-tab ${activeTab === cat.key ? "active" : ""}`}
							data-tab={cat.key}
							onClick={() => setActiveTab(cat.key)}
						>
							{cat.label}
						</button>
					))}
				</div>
			</div>
			<div className="masonry" id="masonry">
				{showcase.cards.map((card) => (
					<MasonryCard
						key={card.imageId}
						category={card.category}
						height={card.height}
						playbookName={card.playbookName}
						prompt={card.prompt}
						agentId={card.playbookSlug}
						imageId={card.imageId}
						media={card.media}
						hidden={activeTab !== "all" && card.category !== activeTab}
						onMakeSame={onMakeSame}
						onCardClick={() => setModalCard(card)}
					/>
				))}
			</div>
			<div ref={loadMoreRef} className={`load-more ${loadCount > 0 || allLoaded ? "visible" : ""}`}>
				{allLoaded ? (
					<span style={{ color: "var(--muted)" }}>已加载全部案例</span>
				) : (
					<>
						<div className="spinner" />
						加载更多案例…
					</>
				)}
			</div>

			{modalCard && (
				<CaseDetailModal
					key={modalCard.imageId}
					open
					onClose={() => setModalCard(null)}
					playbookName={modalCard.playbookName}
					prompt={modalCard.prompt}
					agentId={modalCard.playbookSlug}
					imageId={modalCard.imageId}
					media={modalCard.media}
					onMakeSame={onMakeSame}
				/>
			)}
		</section>
	);
}
