import fs from "node:fs";

const gradlePath =
  process.argv[2] ?? "apps/mobile/android/app/build.gradle";

let source = fs.readFileSync(gradlePath, "utf8");

if (!source.includes("MULTICA_UPLOAD_STORE_FILE")) {
  source = source.replace(
    /(signingConfigs\s*\{\n)/,
    `$1        release {
            if (project.hasProperty("MULTICA_UPLOAD_STORE_FILE")) {
                storeFile file(MULTICA_UPLOAD_STORE_FILE)
                storePassword MULTICA_UPLOAD_STORE_PASSWORD
                keyAlias MULTICA_UPLOAD_KEY_ALIAS
                keyPassword MULTICA_UPLOAD_KEY_PASSWORD
            }
        }
`,
  );
}

const buildTypesIndex = source.indexOf("buildTypes {");
if (buildTypesIndex === -1) {
  throw new Error(`Could not find buildTypes block in ${gradlePath}`);
}

const beforeBuildTypes = source.slice(0, buildTypesIndex);
let buildTypesAndAfter = source.slice(buildTypesIndex);
const previousBuildTypesAndAfter = buildTypesAndAfter;

buildTypesAndAfter = buildTypesAndAfter.replace(
  /(release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/,
  "$1signingConfig signingConfigs.release",
);

const nextSource = beforeBuildTypes + buildTypesAndAfter;

if (buildTypesAndAfter === previousBuildTypesAndAfter) {
  throw new Error(
    `Could not configure release signing in ${gradlePath}; expected Expo/RN Gradle template shape.`,
  );
}

fs.writeFileSync(gradlePath, nextSource);
