import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./tests/helpers/cloudflare-loader.mjs", pathToFileURL("./"));
