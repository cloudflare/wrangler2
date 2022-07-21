import type { UrlPath } from "../../paths";

export const WorkerRouterVersion = 1;

export type WorkerRouter = {
	version: 1;
	include: string[];
	exclude: string[];
};

export function convertRouteToFilterRule(route: UrlPath): string {
	return route.replace(/:\w+\*?/, "*");
}

export function convertRouteListToFilterRules(routes: UrlPath[]): WorkerRouter {
	const includeRules = routes.map((route) => convertRouteToFilterRule(route));
	const uniqueRules = Array.from(new Set(includeRules));
	return {
		version: WorkerRouterVersion,
		include: uniqueRules,
		exclude: [],
	};
}
