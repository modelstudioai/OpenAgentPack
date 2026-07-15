import { useCallback, useSyncExternalStore } from "react";
import { setActiveTask } from "@/lib/store/active-task-store";
import { getTaskStoreSnapshot, subscribeTaskStore } from "@/lib/store/task-client-store";
import { dismissToast, type Toast } from "@/lib/store/toast-store";
import ToastStack from "./ToastStack";

/** App-level toast host so notifications work outside Composer (e.g. settings on 资源中心). */
export default function GlobalToastHost() {
	const taskSnapshot = useSyncExternalStore(subscribeTaskStore, getTaskStoreSnapshot, getTaskStoreSnapshot);

	const handleToastClick = useCallback(
		(toast: Toast) => {
			if (!toast.sessionId) {
				dismissToast(toast.id);
				return;
			}
			const target = taskSnapshot.tasks.find((task) => task.id === toast.sessionId);
			if (!target) {
				dismissToast(toast.id);
				return;
			}
			setActiveTask(target);
			dismissToast(toast.id);
		},
		[taskSnapshot.tasks],
	);

	return <ToastStack onToastClick={handleToastClick} />;
}
