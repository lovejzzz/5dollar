import { chatGPTSignInPath, getChatGPTUser } from "../chatgpt-auth";
import {
  getFiveMode,
  getRuntimeEnv,
  isSponsorAllowed,
} from "../../lib/runtime-env";
import { SponsorForm } from "./SponsorForm";

export default async function SponsorPage() {
  const runtime = getRuntimeEnv();
  const mode = getFiveMode(runtime);
  const user = await getChatGPTUser();
  return (
    <SponsorForm
      live={mode === "live"}
      signedIn={Boolean(user)}
      sponsorAllowed={Boolean(user && isSponsorAllowed(user.email, runtime))}
      signInUrl={chatGPTSignInPath("/sponsor")}
    />
  );
}
