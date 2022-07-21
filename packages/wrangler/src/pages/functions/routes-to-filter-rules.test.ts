import { toUrlPath } from "../../paths";
import {
	convertRouteListToFilterRules,
	convertRouteToFilterRule,
	WorkerRouterVersion,
} from "./routes-to-filter-rules";

describe("routes-to-filter-rules", () => {
	describe("convertRouteToFilterRule", () => {
		const convert = (path: string) => convertRouteToFilterRule(toUrlPath(path));

		describe("single input", () => {
			it("should pass through a single route, no wildcards", () => {
				expect(convert("/api/foo")).toEqual("/api/foo");
			});
			it("should escalate a single param route to a wildcard", () => {
				expect(convert("/api/:foo")).toEqual("/api/*");
			});
			it("should pass through a single wildcard route", () => {
				expect(convert("/api/:baz*")).toEqual("/api/*");
			});
		});
	});

	describe("convertRouteListToFilterRules", () => {
		const convert = (paths: string[]) =>
			convertRouteListToFilterRules(paths.map((p) => toUrlPath(p)));

		describe("multiple rules", () => {
			it("Should deduplicate identical rules", () => {
				expect(convert(["/api/:baz*", "/api/:foo"])).toEqual({
					version: WorkerRouterVersion,
					include: ["/api/*"],
					exclude: [],
				});
			});
		});
	});
});
