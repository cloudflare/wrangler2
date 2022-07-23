export const onRequest: PagesFunction<{ D1: any }> = async ({ env }) => {
	const r = await env.D1.batch([
		env.D1.prepare("PRAGMA table_list"),
		env.D1.prepare("PRAGMA table_info(my_table)"),
	]);

	return new Response(JSON.stringify(r));
};
