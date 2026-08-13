import { AgentSession } from "./agent-session.ts";

/**
 * piwpi's product runtime boundary: one model execution state, one prompt
 * queue, one abort path, one durable session, and built-in piwpi context.
 */
export class CodingAgentHarness extends AgentSession {}
