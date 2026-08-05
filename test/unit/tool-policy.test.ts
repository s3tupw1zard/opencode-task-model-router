import { describe, expect, test } from "vitest";
import { classifyTool } from "../../src/router/tool-policy";
import type { NormalizedRoleConfig, NormalizedToolsConfig } from "../../src/router/config";

describe("classifyTool", () => {
  const baseRole: NormalizedRoleConfig = {
    description: "Test role",
    prompt: "Test prompt",
    returnProtocol: "Test protocol",
    defaultTier: "fast",
    allowedTiers: ["fast", "medium"],
    taskPatterns: [],
    modelOverrides: {},
    tools: {
      allowCategories: [],
      denyCategories: [],
      allowMcp: [],
      denyMcp: [],
      allowPatterns: [],
      denyPatterns: [],
      allowCommands: [],
      denyCommands: [],
    },
  };

  const baseTools: NormalizedToolsConfig = {
    categories: {
      localRead: ["read", "grep", "glob"],
      externalResearch: ["webfetch", "websearch"],
      memoryRead: [],
      memoryWrite: [],
      externalWrite: [],
      codeMutation: ["edit", "write"],
      commandExecution: ["bash", "shell"],
    },
    mcp: {
      github: {
        readPatterns: ["github_get_*", "github_list_*", "github_search_*"],
        writePatterns: ["github_create_*", "github_update_*", "github_delete_*"],
        readCategory: "externalResearch",
        writeCategory: "externalWrite",
      },
      memory: {
        readPatterns: ["memory_read_*", "memory_search_*"],
        writePatterns: ["memory_create_*", "memory_add_*"],
        readCategory: "memoryRead",
        writeCategory: "memoryWrite",
      },
    },
    unknownToolPolicy: "deny",
  };

  describe("allowed patterns", () => {
    test("allows tool matching allowPatterns", () => {
      const role: NormalizedRoleConfig = {
        ...baseRole,
        tools: {
          ...baseRole.tools,
          allowPatterns: ["github_get_*"],
        },
      };
      const result = classifyTool("github_get_issue", {}, role, baseTools);
      expect(result.decision).toBe("allow");
      expect(result.reason).toContain("allow pattern");
    });

    test("allows tool in allowCategories", () => {
      const role: NormalizedRoleConfig = {
        ...baseRole,
        tools: {
          ...baseRole.tools,
          allowCategories: ["localRead"],
        },
      };
      const result = classifyTool("read", {}, role, baseTools);
      expect(result.decision).toBe("allow");
      expect(result.reason).toContain("allowed category");
    });
  });

  describe("denied patterns", () => {
    test("denies tool matching denyPatterns", () => {
      const role: NormalizedRoleConfig = {
        ...baseRole,
        tools: {
          ...baseRole.tools,
          denyPatterns: ["github_create_*"],
        },
      };
      const result = classifyTool("github_create_branch", {}, role, baseTools);
      expect(result.decision).toBe("deny");
      expect(result.reason).toContain("deny pattern");
    });

    test("denies tool in denyCategories", () => {
      const role: NormalizedRoleConfig = {
        ...baseRole,
        tools: {
          ...baseRole.tools,
          denyCategories: ["codeMutation"],
        },
      };
      const result = classifyTool("edit", {}, role, baseTools);
      expect(result.decision).toBe("deny");
      expect(result.reason).toContain("denied category");
    });
  });

  describe("overlapping allow and deny", () => {
    test("deny takes precedence over allow (deny-first)", () => {
      const role: NormalizedRoleConfig = {
        ...baseRole,
        tools: {
          ...baseRole.tools,
          allowPatterns: ["github_*"],
          denyPatterns: ["github_create_*"],
        },
      };
      const result = classifyTool("github_create_branch", {}, role, baseTools);
      expect(result.decision).toBe("deny");
      expect(result.reason).toContain("deny pattern");
    });

    test("deny category takes precedence over allow pattern", () => {
      const role: NormalizedRoleConfig = {
        ...baseRole,
        tools: {
          ...baseRole.tools,
          allowPatterns: ["edit"],
          denyCategories: ["codeMutation"],
        },
      };
      const result = classifyTool("edit", {}, role, baseTools);
      expect(result.decision).toBe("deny");
      expect(result.reason).toContain("denied category");
    });
  });

  describe("unknown tools", () => {
    test("returns unknown when no rule matches", () => {
      const role: NormalizedRoleConfig = {
        ...baseRole,
        tools: {
          ...baseRole.tools,
          allowCategories: ["localRead"],
        },
      };
      const result = classifyTool("unknown_tool", {}, role, baseTools);
      expect(result.decision).toBe("unknown");
      expect(result.reason).toContain("no matching");
    });

    test("unknown tool policy 'deny' blocks unknown tools", () => {
      const role: NormalizedRoleConfig = {
        ...baseRole,
        tools: {
          ...baseRole.tools,
          allowCategories: ["localRead"],
        },
      };
      const tools: NormalizedToolsConfig = {
        ...baseTools,
        unknownToolPolicy: "deny",
      };
      const result = classifyTool("unknown_tool", {}, role, tools);
      expect(result.decision).toBe("unknown");
    });

    test("unknown tool policy 'allow' allows unknown tools", () => {
      const role: NormalizedRoleConfig = {
        ...baseRole,
        tools: {
          ...baseRole.tools,
          allowCategories: ["localRead"],
        },
      };
      const tools: NormalizedToolsConfig = {
        ...baseTools,
        unknownToolPolicy: "allow",
      };
      const result = classifyTool("unknown_tool", {}, role, tools);
      expect(result.decision).toBe("unknown");
    });
  });

  describe("GitHub read versus write", () => {
    test("allows GitHub read tools when allowMcp includes github", () => {
      const role: NormalizedRoleConfig = {
        ...baseRole,
        tools: {
          ...baseRole.tools,
          allowMcp: ["github"],
          allowCategories: ["externalResearch"],
        },
      };
      const result = classifyTool("github_get_issue", {}, role, baseTools);
      expect(result.decision).toBe("allow");
      expect(result.reason).toContain("allowed MCP");
      expect(result.reason).toContain("read");
    });

    test("allows GitHub write tools when allowMcp includes github", () => {
      const role: NormalizedRoleConfig = {
        ...baseRole,
        tools: {
          ...baseRole.tools,
          allowMcp: ["github"],
          allowCategories: ["externalWrite"],
        },
      };
      const result = classifyTool("github_create_branch", {}, role, baseTools);
      expect(result.decision).toBe("allow");
      expect(result.reason).toContain("allowed MCP");
      expect(result.reason).toContain("write");
    });

    test("denies GitHub write tools when only allowMcp includes github", () => {
      const role: NormalizedRoleConfig = {
        ...baseRole,
        tools: {
          ...baseRole.tools,
          allowMcp: ["github"],
          allowCategories: ["externalResearch"], // only read category allowed
        },
      };
      const result = classifyTool("github_create_branch", {}, role, baseTools);
      expect(result.decision).toBe("unknown");
    });
  });

  describe("Memory read versus write", () => {
    test("allows memory read tools when allowMcp includes memory", () => {
      const role: NormalizedRoleConfig = {
        ...baseRole,
        tools: {
          ...baseRole.tools,
          allowMcp: ["memory"],
          allowCategories: ["memoryRead"],
        },
      };
      const result = classifyTool("memory_read_graph", {}, role, baseTools);
      expect(result.decision).toBe("allow");
      expect(result.reason).toContain("allowed MCP");
      expect(result.reason).toContain("read");
    });

    test("allows memory write tools when allowMcp includes memory", () => {
      const role: NormalizedRoleConfig = {
        ...baseRole,
        tools: {
          ...baseRole.tools,
          allowMcp: ["memory"],
          allowCategories: ["memoryWrite"],
        },
      };
      const result = classifyTool("memory_create_entity", {}, role, baseTools);
      expect(result.decision).toBe("allow");
      expect(result.reason).toContain("allowed MCP");
      expect(result.reason).toContain("write");
    });

    test("denies memory write when only read allowed", () => {
      const role: NormalizedRoleConfig = {
        ...baseRole,
        tools: {
          ...baseRole.tools,
          allowMcp: ["memory"],
          allowCategories: ["memoryRead"],
        },
      };
      const result = classifyTool("memory_create_entity", {}, role, baseTools);
      expect(result.decision).toBe("unknown");
    });
  });

  describe("configurable MCP names", () => {
    test("works with custom MCP names", () => {
      const role: NormalizedRoleConfig = {
        ...baseRole,
        tools: {
          ...baseRole.tools,
          allowMcp: ["custom_mcp"],
          allowCategories: ["externalResearch"],
        },
      };
      const tools: NormalizedToolsConfig = {
        ...baseTools,
        mcp: {
          custom_mcp: {
            readPatterns: ["custom_*"],
            writePatterns: [],
            readCategory: "externalResearch",
            writeCategory: "externalWrite",
          },
        },
      };
      const result = classifyTool("custom_search", {}, role, tools);
      expect(result.decision).toBe("allow");
      expect(result.reason).toContain("allowed MCP");
    });
  });

  describe("OpenCode permission non-bypass", () => {
    test("role policy cannot be bypassed by tool name manipulation", () => {
      const role: NormalizedRoleConfig = {
        ...baseRole,
        tools: {
          ...baseRole.tools,
          denyPatterns: ["edit", "write"],
          allowCategories: ["localRead"],
        },
      };
      // Try various bypass attempts
      expect(classifyTool("edit", {}, role, baseTools).decision).toBe("deny");
      expect(classifyTool("EDIT", {}, role, baseTools).decision).toBe("unknown"); // case-sensitive
      expect(classifyTool("edit_tool", {}, role, baseTools).decision).toBe("unknown"); // not exact match
      expect(classifyTool("edit_file", {}, role, baseTools).decision).toBe("unknown"); // not exact match
    });

    test("deny patterns are strict", () => {
      const role: NormalizedRoleConfig = {
        ...baseRole,
        tools: {
          ...baseRole.tools,
          denyPatterns: ["bash", "shell"],
        },
      };
      expect(classifyTool("bash", {}, role, baseTools).decision).toBe("deny");
      expect(classifyTool("shell", {}, role, baseTools).decision).toBe("deny");
      expect(classifyTool("bash_script", {}, role, baseTools).decision).toBe("unknown");
    });
  });

  describe("command pattern checks", () => {
    test("allows commands matching allowCommands", () => {
      const role: NormalizedRoleConfig = {
        ...baseRole,
        tools: {
          ...baseRole.tools,
          allowCommands: ["npm_*", "git_*"],
        },
      };
      const result = classifyTool("bash", { command: "npm install" }, role, baseTools);
      expect(result.decision).toBe("allow");
      expect(result.reason).toContain("command");
      expect(result.reason).toContain("allow pattern");
    });

    test("denies commands matching denyCommands", () => {
      const role: NormalizedRoleConfig = {
        ...baseRole,
        tools: {
          ...baseRole.tools,
          denyCommands: ["rm_*", "sudo_*"],
        },
      };
      const result = classifyTool("bash", { command: "rm -rf /" }, role, baseTools);
      expect(result.decision).toBe("deny");
      expect(result.reason).toContain("command");
      expect(result.reason).toContain("deny pattern");
    });

    test("deny commands take precedence over allow commands", () => {
      const role: NormalizedRoleConfig = {
        ...baseRole,
        tools: {
          ...baseRole.tools,
          allowCommands: ["npm_*"],
          denyCommands: ["npm_uninstall"],
        },
      };
      const result = classifyTool("bash", { command: "npm uninstall package" }, role, baseTools);
      expect(result.decision).toBe("deny");
    });
  });

  describe("MCP write precedence", () => {
    test("write match takes precedence when tool matches both read and write patterns", () => {
      const role: NormalizedRoleConfig = {
        ...baseRole,
        tools: {
          ...baseRole.tools,
          allowMcp: ["github"],
          allowCategories: ["externalWrite"],
        },
      };
      // Create a tool that matches both read and write patterns
      const tools: NormalizedToolsConfig = {
        ...baseTools,
        mcp: {
          github: {
            readPatterns: ["github_dual_*"],
            writePatterns: ["github_dual_*"],
            readCategory: "externalResearch",
            writeCategory: "externalWrite",
          },
        },
      };
      const result = classifyTool("github_dual_operation", {}, role, tools);
      expect(result.decision).toBe("allow");
      expect(result.reason).toContain("write");
    });
  });
});
