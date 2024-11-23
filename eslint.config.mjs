import globals from "globals";

export default [{
    languageOptions: {
        globals: {
            ...globals.browser,
            ...globals.commonjs,
            ...globals.node,
        },

        ecmaVersion: "latest",
        sourceType: "commonjs",
    },

    rules: {},
}];