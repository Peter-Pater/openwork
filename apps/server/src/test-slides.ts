import { resolveServerConfig } from "./config.js";
import { callGoogleWorkspaceExtensionAction } from "./extensions/google-workspace.js";

async function run() {
  try {
    const config = await resolveServerConfig({ configPath: "C:\\Users\\xinch\\AppData\\Roaming\\openwork\\server.json", workspaces: [] });
    const result = await callGoogleWorkspaceExtensionAction(
      config,
      "slides_update_presentation",
      {
        presentationId: "1EN-fJ1UrJymOsEjrEyE-PGpEOw5yhuGhyOoufoeM-NI",
        requests: [
          {
            updatePageElementTransform: {
              objectId: "SLIDES_API1842820341_0",
              transform: {
                scaleX: 310.8808,
                scaleY: 310.8808,
                translateX: 0,
                translateY: 1071750,
                unit: "EMU"
              },
              applyMode: "REPLACE"
            }
          }
        ]
      },
      {}
    );
    console.log("Success:", JSON.stringify(result, null, 2));
  } catch (error) {
    console.error("Error occurred:", error);
  }
}

run();
