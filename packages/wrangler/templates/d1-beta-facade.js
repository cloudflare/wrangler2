// src/shim.ts
export * from "__ENTRY_POINT__";
import worker from "__ENTRY_POINT__";

// src/index.ts
var Database = class {
	binding;
	constructor(binding) {
		this.binding = binding;
	}
	prepare(query) {
		return new PreparedStatement(this, query);
	}
	async dump() {
		const response = await this.binding.fetch("/dump", {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
		});
		if (response.status !== 200) {
			const err = await response.json();
			throw new Error("D1_DUMP_ERROR", {
				cause: new Error(err.error),
			});
		}
		return await response.arrayBuffer();
	}
	async batch(statements) {
		const exec = await this._send(
			"/query",
			statements.map((s) => s.statement),
			statements.map((s) => s.params)
		);
		return exec;
	}
	async exec(query) {
		const lines = query.trim().split("\n");
		const exec = await this._send("/query", lines, []);
		const error = exec
			.map((r) => {
				return r.error ? 1 : 0;
			})
			.indexOf(1);
		if (error !== -1) {
			throw new Error("D1_EXEC_ERROR", {
				cause: new Error(
					`Error in line ${error + 1}: ${lines[error]}: ${exec[error].error}`
				),
			});
		} else {
			return {
				count: exec.length,
				duration: exec.reduce((p, c) => {
					return p.duration + c.duration;
				}),
			};
		}
	}
	async _send(endpoint, query, params) {
		const body = JSON.stringify(
			typeof query == "object"
				? query.map((s, index) => {
						return { sql: s, params: params[index] };
				  })
				: {
						sql: query,
						params,
				  }
		);
		const response = await this.binding.fetch(endpoint, {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body,
		});
		if (response.status !== 200) {
			const err = await response.json();
			throw new Error("D1_ERROR", { cause: new Error(err.error) });
		}
		const answer = await response.json();
		return Array.isArray(answer) ? answer : answer;
	}
};
var PreparedStatement = class {
	statement;
	database;
	params;
	constructor(database, statement, values) {
		this.database = database;
		this.statement = statement;
		this.params = values || [];
	}
	bind(...values) {
		return new PreparedStatement(this.database, this.statement, values);
	}
	async first(colName) {
		const info = await this.database._send(
			"/query",
			this.statement,
			this.params
		);
		const results = info.results;
		if (results.length < 1) {
			throw new Error("D1_NORESULTS", { cause: new Error("No results") });
		}
		const result = results[0];
		if (colName !== void 0) {
			if (result[colName] === void 0) {
				throw new Error("D1_COLUMN_NOTFOUND", {
					cause: new Error(`Column not found`),
				});
			}
			return result[colName];
		} else {
			return result;
		}
	}
	async run() {
		return this.database._send("/execute", this.statement, this.params);
	}
	async all() {
		return await this.database._send("/query", this.statement, this.params);
	}
	async raw() {
		const s = await this.database._send("/query", this.statement, this.params);
		const raw = [];
		for (var r in s.results) {
			const entry = Object.keys(s.results[r]).map((k) => {
				return s.results[r][k];
			});
			raw.push(entry);
		}
		return raw;
	}
};

// src/shim.ts
var d1imports = __D1_IMPORTS__;
var D1_BETA_PREFIX = `__D1_BETA__`;
var envMap = /* @__PURE__ */ new Map();
function getMaskedEnv(env) {
	if (envMap.has(env)) return envMap.get(env);
	const envMask = {};
	d1imports.forEach((bindingName) => {
		if (bindingName.startsWith(D1_BETA_PREFIX)) {
			const sansPrefix = bindingName.slice(D1_BETA_PREFIX.length);
			envMask[sansPrefix] = {
				value: new Database(env[bindingName]),
				enumerable: true,
			};
			envMask[bindingName] = { value: void 0, enumerable: false };
		}
	});
	const combinedEnv = Object.create(env, envMask);
	envMap.set(env, combinedEnv);
	return combinedEnv;
}
var shim_default = {
	async fetch(request, env, ctx) {
		return worker.fetch(request, getMaskedEnv(env), ctx);
	},
};
export { shim_default as default };
