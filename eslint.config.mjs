import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier";
import jsdoc from "eslint-plugin-jsdoc";

export default [
    {
        ignores: [
            "node_modules/**",
            "coverage/**",
            ".nyc_output/**",
            // measuring scripts and examples, each with its own compact style
            "bench/**",
            "examples/**",
            "src/types.d.ts"
        ]
    },
    js.configs.recommended,
    {
        files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "commonjs",
            globals: {
                ...globals.node
            }
        },
        rules: {
            "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
            eqeqeq: ["error", "smart"],
            "no-var": "error",
            "prefer-const": ["error", { destructuring: "all" }],
            "no-console": "off",
            // some getters return undefined on purpose when there is nothing to report
            "getter-return": ["error", { allowImplicit: true }],
            // a blank line between class members. Prettier keeps one that is already there but
            // never adds one, so this is the rule that puts it there, and --fix does it
            "lines-between-class-members": ["error", "always", { exceptAfterSingleLine: false }]
        }
    },
    {
        // every function in src/ carries a JSDoc block, and this is what keeps it that way.
        // Only src/: a block on every arrow function in the tests would be noise
        files: ["src/**/*.js"],
        plugins: { jsdoc },
        rules: {
            // compile() in query.js builds its text into a let and returns it; the source is
            // settled, so the rule steps aside here
            "prefer-const": "off",
            "jsdoc/require-jsdoc": [
                "error",
                {
                    require: { MethodDefinition: true, FunctionDeclaration: true },
                    checkGetters: true,
                    checkSetters: false
                }
            ],
            // the tags that are there have to be true: a renamed parameter whose @param still
            // says the old name is worse than no @param at all
            "jsdoc/check-param-names": "error",
            "jsdoc/check-tag-names": "error",
            "jsdoc/no-undefined-types": "off",
            "jsdoc/require-param": "off",
            "jsdoc/require-returns": "off"
        }
    },
    {
        files: ["eslint.config.mjs"],
        languageOptions: {
            sourceType: "module"
        }
    },
    // formatting is prettier's job; this turns off every rule that would argue with it
    prettier
];
