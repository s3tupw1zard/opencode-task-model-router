// ---------------------------------------------------------------------------
// Tool policy engine — deny-first role-based tool classification
// ---------------------------------------------------------------------------

import type {
  McpToolConfig,
  NormalizedRoleConfig,
  NormalizedToolsConfig,
  ToolCategory,
} from "./config";
import { formatAgentName } from "./normalize";
import { matchGlob } from "./patterns";

export interface ToolDecision {
  decision: "allow" | "deny" | "unknown";
  reason: string;
}

/**
 * Extracts the command name from tool arguments (first token for bash/shell tools).
 */
function extractCommandName(toolArgs: unknown): string | null {
  if (!toolArgs || typeof toolArgs !== "object") {
    return null;
  }
  const args = toolArgs as Record<string, unknown>;
  const command = args.command;
  if (typeof command !== "string" || !command.trim()) {
    return null;
  }
  // Extract first token (command name)
  const firstToken = command.trim().split(/\s+/)[0];
  return firstToken ?? null;
}

/**
 * Checks if a tool name matches any pattern in the list.
 */
function matchesAnyPattern(tool: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchGlob(pattern, tool));
}

/**
 * Checks if a command matches any pattern in the list.
 */
function matchesCommandPatterns(command: string | null, patterns: string[]): boolean {
  if (!command) {
    return false;
  }
  return patterns.some((pattern) => matchGlob(pattern, command));
}

/**
 * Checks if a tool is in any of the specified categories.
 */
function toolInCategories(
  tool: string,
  categories: ToolCategory[],
  allCategories: Record<ToolCategory, string[]>,
): boolean {
  return categories.some((category) => {
    const toolsInCategory = allCategories[category] ?? [];
    return toolsInCategory.includes(tool);
  });
}

/**
 * Classifies an MCP tool as read or write, with write taking precedence.
 */
function classifyMcpTool(
  tool: string,
  mcpName: string,
  mcpConfig: McpToolConfig,
): { matches: boolean; isWrite: boolean } {
  const matchesRead = matchesAnyPattern(tool, mcpConfig.readPatterns);
  const matchesWrite = matchesAnyPattern(tool, mcpConfig.writePatterns);

  // Write takes precedence (conservative)
  if (matchesWrite) {
    return { matches: true, isWrite: true };
  }
  if (matchesRead) {
    return { matches: true, isWrite: false };
  }
  return { matches: false, isWrite: false };
}

/**
 * Classifies a tool according to the role's policy with deny-first semantics.
 *
 * @param tool - Tool name (e.g., "github_get_issue", "bash")
 * @param toolArgs - Tool arguments (used for command extraction)
 * @param role - Role configuration with tool policies
 * @param tools - Global tools configuration with categories and MCP settings
 * @returns Tool decision with allow/deny/unknown and reason
 */
export function classifyTool(
  tool: string,
  toolArgs: unknown,
  role: NormalizedRoleConfig,
  tools: NormalizedToolsConfig,
): ToolDecision {
  const { tools: roleTools } = role;

  // 1. Check deny patterns (deny-first)
  if (matchesAnyPattern(tool, roleTools.denyPatterns)) {
    return {
      decision: "deny",
      reason: `matches deny pattern for role`,
    };
  }

  // 2. Check deny categories
  if (toolInCategories(tool, roleTools.denyCategories, tools.categories)) {
    return {
      decision: "deny",
      reason: `in denied category`,
    };
  }

  // 3. Check deny MCP patterns
  for (const [mcpName, mcpConfig] of Object.entries(tools.mcp)) {
    if (roleTools.denyMcp.includes(mcpName)) {
      const { matches, isWrite } = classifyMcpTool(tool, mcpName, mcpConfig);
      if (matches) {
        return {
          decision: "deny",
          reason: `matches denied MCP '${mcpName}' (${isWrite ? "write" : "read"})`,
        };
      }
    }
  }

  // 4. Check deny command patterns
  const commandName = extractCommandName(toolArgs);
  if (matchesCommandPatterns(commandName, roleTools.denyCommands)) {
    return {
      decision: "deny",
      reason: `command '${commandName}' matches deny pattern`,
    };
  }

  // 5. Check allow patterns
  if (matchesAnyPattern(tool, roleTools.allowPatterns)) {
    return {
      decision: "allow",
      reason: `matches allow pattern`,
    };
  }

  // 6. Check allow categories
  if (toolInCategories(tool, roleTools.allowCategories, tools.categories)) {
    return {
      decision: "allow",
      reason: `in allowed category`,
    };
  }

  // 7. Check allow MCP patterns
  for (const [mcpName, mcpConfig] of Object.entries(tools.mcp)) {
    if (roleTools.allowMcp.includes(mcpName)) {
      const { matches, isWrite } = classifyMcpTool(tool, mcpName, mcpConfig);
      if (matches) {
        // Check if this MCP's category is allowed
        const category = isWrite ? mcpConfig.writeCategory : mcpConfig.readCategory;
        const isAllowedCategory = roleTools.allowCategories.includes(category as ToolCategory);
        if (isAllowedCategory) {
          return {
            decision: "allow",
            reason: `matches allowed MCP '${mcpName}' (${isWrite ? "write" : "read"})`,
          };
        }
      }
    }
  }

  // 8. Check allow command patterns
  if (matchesCommandPatterns(commandName, roleTools.allowCommands)) {
    return {
      decision: "allow",
      reason: `command '${commandName}' matches allow pattern`,
    };
  }

  // 9. No match → unknown
  return {
    decision: "unknown",
    reason: `no matching allow or deny rule`,
  };
}

/**
 * Resolves the role name from an agent name, handling both canonical and alias names.
 *
 * @param agentName - Agent name (e.g., "explore-fast", "fast", "my-custom-alias")
 * @param cfg - Normalized router configuration
 * @returns Role name or null if not resolvable
 */
export function resolveRoleFromAgentName(
  agentName: string,
  cfg: {
    compatibility: { aliases: Record<string, { role: string; tier: string; agentName: string }> };
    roles: Record<string, NormalizedRoleConfig>;
  },
): string | null {
  // 1. Check configured aliases (both alias name and target agent name)
  for (const [aliasName, identity] of Object.entries(cfg.compatibility.aliases)) {
    if (aliasName === agentName || identity.agentName === agentName) {
      return identity.role;
    }
  }

  // 2. Check canonical agent names via role/tier matrix
  for (const [roleName, roleConfig] of Object.entries(cfg.roles)) {
    for (const tier of roleConfig.allowedTiers) {
      if (formatAgentName(roleName, tier) === agentName) {
        return roleName;
      }
    }
  }

  // 3. Cannot resolve
  return null;
}
