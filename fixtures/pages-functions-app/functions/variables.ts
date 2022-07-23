export const onRequest = ({ env }) => {
	return new Response(JSON.stringify(env.VAR_1), {
		headers: { "Content-Type": "application/json" },
	});
};
