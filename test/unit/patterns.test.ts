import { describe, expect, test } from "vitest";
import { matchGlob } from "../../src/router/patterns";

describe("matchGlob", () => {
  describe("wildcard * matching", () => {
    test("matches any characters", () => {
      expect(matchGlob("github_get_*", "github_get_issue")).toBe(true);
      expect(matchGlob("github_get_*", "github_get_issue_123")).toBe(true);
      expect(matchGlob("github_get_*", "github_get_")).toBe(true);
    });

    test("matches zero characters", () => {
      expect(matchGlob("test*", "test")).toBe(true);
      expect(matchGlob("*", "anything")).toBe(true);
    });

    test("matches multiple wildcards", () => {
      expect(matchGlob("*get*", "github_get_issue")).toBe(true);
      expect(matchGlob("*_*_*", "github_get_issue")).toBe(true);
    });
  });

  describe("single-char ? matching", () => {
    test("matches exactly one character", () => {
      expect(matchGlob("read?", "read1")).toBe(true);
      expect(matchGlob("read?", "readA")).toBe(true);
    });

    test("fails on zero characters", () => {
      expect(matchGlob("read?", "read")).toBe(false);
    });

    test("fails on multiple characters", () => {
      expect(matchGlob("read?", "read12")).toBe(false);
    });

    test("matches multiple wildcards", () => {
      expect(matchGlob("?ead?", "read1")).toBe(true);
      expect(matchGlob("?ead?", "Read2")).toBe(true);
    });
  });

  describe("case-insensitivity", () => {
    test("matches regardless of case", () => {
      expect(matchGlob("GITHUB_GET_*", "github_get_issue")).toBe(true);
      expect(matchGlob("github_get_*", "GITHUB_GET_ISSUE")).toBe(true);
      expect(matchGlob("READ?", "read1")).toBe(true);
      expect(matchGlob("read?", "READ1")).toBe(true);
    });
  });

  describe("edge cases", () => {
    test("returns false for empty pattern", () => {
      expect(matchGlob("", "test")).toBe(false);
    });

    test("returns false for empty value", () => {
      expect(matchGlob("test", "")).toBe(false);
    });

    test("returns false for both empty", () => {
      expect(matchGlob("", "")).toBe(false);
    });

    test("exact match without wildcards", () => {
      expect(matchGlob("github_get_issue", "github_get_issue")).toBe(true);
      expect(matchGlob("github_get_issue", "github_get_issues")).toBe(false);
    });

    test("special regex characters are escaped", () => {
      expect(matchGlob("test.txt", "test.txt")).toBe(true);
      expect(matchGlob("test.txt", "testXtxt")).toBe(false);
      expect(matchGlob("test[1]", "test[1]")).toBe(true);
      expect(matchGlob("test[1]", "test1")).toBe(false);
    });
  });

  describe("complex patterns", () => {
    test("MCP tool patterns", () => {
      expect(matchGlob("searxng_*", "searxng_search")).toBe(true);
      expect(matchGlob("memory_read_*", "memory_read_graph")).toBe(true);
      expect(matchGlob("memory_search_*", "memory_search_nodes")).toBe(true);
      expect(matchGlob("github_get_*", "github_get_file_contents")).toBe(true);
      expect(matchGlob("github_list_*", "github_list_commits")).toBe(true);
      expect(matchGlob("github_create_*", "github_create_branch")).toBe(true);
    });

    test("command patterns", () => {
      expect(matchGlob("npm_*", "npm_install")).toBe(true);
      expect(matchGlob("git_*", "git_commit")).toBe(true);
      expect(matchGlob("docker_*", "docker_build")).toBe(true);
    });
  });
});
