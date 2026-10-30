const { withProjectBuildGradle } = require("expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

module.exports = function withFbjniVersion(config) {
  return withProjectBuildGradle(config, (config) => {
    const reactNativeRoot = path.dirname(require.resolve("react-native/package.json"));
    const versions = fs.readFileSync(path.join(reactNativeRoot, "gradle/libs.versions.toml"), "utf8");
    const version = versions.match(/^fbjni\s*=\s*"([^"]+)"/m)?.[1];
    if (!version) throw new Error("Cannot resolve React Native's fbjni version");
    const marker = "// Align fbjni with React Native's native runtime.";
    if (!config.modResults.contents.includes(marker)) {
      // Shiki requests fbjni:+, which can select binaries requiring a newer
      // libc++ than React Native packages. Use RN's own version catalog.
      config.modResults.contents += `
${marker}
allprojects {
    configurations.configureEach {
        resolutionStrategy.force 'com.facebook.fbjni:fbjni:${version}'
    }
}
`;
    }
    return config;
  });
};
