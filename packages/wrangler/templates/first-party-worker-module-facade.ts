// @ts-ignore entry point will get replaces
import worker from "__ENTRY_POINT__";

type Env = {
	// TODO: type this
};

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return worker.fetch(request, env, ctx);
	},
};
