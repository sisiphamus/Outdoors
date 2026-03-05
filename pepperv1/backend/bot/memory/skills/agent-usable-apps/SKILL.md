# Building Agent-Usable Apps

Technical knowledge for making applications that AI agents can discover, invoke, and interact with programmatically.

## The Landscape (as of early 2026)

There are two distinct problems in agent-app integration:

1. **Agent-to-Tool**: An agent calls YOUR app as a tool (MCP, OpenAI function calling, LangChain tools, CrewAI tools)
2. **Agent-to-Agent**: An agent delegates to YOUR agent (A2A, ACP, ANP)

Most developers need #1. The protocols below are ordered by adoption and practical importance.

---

## 1. MCP (Model Context Protocol) -- The De Facto Standard

**What**: Open protocol by Anthropic (Nov 2024). Adopted by OpenAI (Mar 2025). JSON-RPC 2.0 over stdio or HTTP. The dominant standard for agent-to-tool communication.

**Who supports it**: Claude, OpenAI, Cursor, Windsurf, VS Code, Cline, and 50+ clients.

**Three primitives your server can expose**:
- **Tools**: Functions the LLM can call (with user approval). This is the primary one.
- **Resources**: Read-only data (like files, API responses) the client can pull.
- **Prompts**: Pre-written templates for common tasks.

### Python MCP Server (FastMCP)

```python
# pip install "mcp[cli]"
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("my-service")

@mcp.tool()
async def search_database(query: str, limit: int = 10) -> str:
    """Search the database for records matching the query.

    Args:
        query: Search terms to match against records
        limit: Maximum number of results to return
    """
    results = await db.search(query, limit=limit)
    return format_results(results)

@mcp.resource("config://app")
def get_config() -> str:
    """Return the current application configuration."""
    return json.dumps(config)

@mcp.prompt()
def debug_prompt(error_message: str) -> str:
    """Create a debugging prompt for an error."""
    return f"Analyze this error and suggest fixes:\n{error_message}"

if __name__ == "__main__":
    mcp.run(transport="stdio")  # or transport="sse" for HTTP
```

**Key details**:
- SDK: `pip install "mcp[cli]"` (Python 3.10+, SDK v1.2.0+)
- FastMCP auto-generates JSON schemas from type hints and docstrings
- Docstrings are CRITICAL: the LLM reads them to decide when/how to call your tool
- Args section in docstring maps to parameter descriptions in the schema
- Return type should be `str` (the LLM consumes text)

### TypeScript MCP Server

```typescript
// npm install @modelcontextprotocol/sdk zod@3
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "my-service",
  version: "1.0.0",
});

server.registerTool(
  "search_database",
  {
    description: "Search the database for records matching the query",
    inputSchema: {
      query: z.string().describe("Search terms to match against records"),
      limit: z.number().min(1).max(100).default(10)
        .describe("Maximum number of results"),
    },
  },
  async ({ query, limit }) => {
    const results = await db.search(query, limit);
    return {
      content: [{ type: "text", text: formatResults(results) }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

**Key details**:
- Zod schemas define input validation AND generate JSON schema for the LLM
- Return `{ content: [{ type: "text", text: "..." }] }` for tool results
- Can also return `type: "image"` with base64 data or `type: "resource"` with URI

### MCP Transport Types

| Transport | Use Case | How It Works |
|-----------|----------|-------------|
| **stdio** | Local tools, CLI integration | Server is a subprocess. stdin/stdout carry JSON-RPC. All logs must go to stderr. |
| **Streamable HTTP** | Remote/multi-user servers | HTTP POST for requests, SSE for streaming. Production deployments. |
| **SSE** (legacy) | Older remote servers | Being replaced by Streamable HTTP. Still works. |

### MCP Client Registration

```json
// claude_desktop_config.json or .claude.json
{
  "mcpServers": {
    "my-service": {
      "command": "uv",
      "args": ["--directory", "/path/to/server", "run", "server.py"]
    }
  }
}
```

For remote HTTP servers:
```json
{
  "mcpServers": {
    "my-service": {
      "url": "https://my-service.example.com/mcp"
    }
  }
}
```

### MCP Design Rules
- **Never use `print()` in stdio servers** -- it corrupts JSON-RPC. Use `logging` or `print(..., file=sys.stderr)`.
- **Never use `console.log()` in TS stdio servers** -- use `console.error()`.
- Tool names should be `snake_case`, descriptive, verb-first (`search_users`, `create_ticket`).
- Descriptions must tell the LLM WHEN to use the tool, not just what it does.
- Keep tool count manageable (<20 per server). Too many tools confuse the LLM.
- Return errors as text, not exceptions. The LLM needs to read error context to recover.

---

## 2. OpenAI Function Calling (Tool Use)

**What**: The JSON-schema-based mechanism for GPT models to invoke external functions. Works with Chat Completions API and Responses API.

### Tool Definition Format

```json
{
  "type": "function",
  "function": {
    "name": "search_database",
    "description": "Search the database for records matching the query",
    "strict": true,
    "parameters": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "description": "Search terms to match against records"
        },
        "limit": {
          "type": "integer",
          "description": "Maximum number of results to return"
        }
      },
      "required": ["query", "limit"],
      "additionalProperties": false
    }
  }
}
```

### Strict Mode (`strict: true`)
- Model output guaranteed to match your schema exactly
- Requires `additionalProperties: false` on every object
- ALL fields must be listed in `required` (use nullable types for optional)
- Supported types: `string`, `number`, `integer`, `boolean`, `null`, `object`, `array`, `enum`
- No `minLength`, `maxLength`, `pattern`, `minimum`, `maximum` in strict mode (use descriptions instead)

### Execution Loop

```python
# 1. Send messages + tools definition
response = client.chat.completions.create(
    model="gpt-4o",
    messages=messages,
    tools=tools,  # your tool definitions
)

# 2. Check if model wants to call a tool
if response.choices[0].message.tool_calls:
    for call in response.choices[0].message.tool_calls:
        name = call.function.name
        args = json.loads(call.function.arguments)
        result = execute_function(name, args)

        # 3. Send result back
        messages.append({"role": "tool", "tool_call_id": call.id, "content": result})

    # 4. Get final response
    response = client.chat.completions.create(model="gpt-4o", messages=messages)
```

### OpenAI Agents SDK (FunctionTool)

```python
from agents import Agent, function_tool

@function_tool
def search_database(query: str, limit: int = 10) -> str:
    """Search the database for records matching the query."""
    return json.dumps(results)

agent = Agent(
    name="Research Assistant",
    tools=[search_database],
)
```

**Key details**:
- `@function_tool` auto-generates schema from type hints + docstring
- Returns: `str`, `ToolOutputText`, `ToolOutputImage`, `ToolOutputFileContent`, or list of them
- `strict_json_schema` defaults to `True` (enforces strict mode)
- `needs_approval`: can be `bool` or async callable for dynamic approval logic
- `is_enabled`: can conditionally hide tools from the LLM
- Timeout: `timeout_seconds` + `timeout_behavior` ("error_as_result" or "raise_exception")

### Responses API (newer, recommended for new projects)

The Responses API replaces Assistants API (sunsetting Aug 2026). It supports built-in tools (web_search, file_search, computer_use) alongside custom function tools, and runs an agentic loop where the model can call multiple tools in a single request.

---

## 3. LangChain / LangGraph Tools

**What**: Python framework for building LLM apps. Tools are the primary way agents interact with external systems.

### Decorator Approach

```python
from langchain_core.tools import tool

@tool
def search_database(query: str, limit: int = 10) -> str:
    """Search the database for records matching the query.

    Args:
        query: Search terms to match against records
        limit: Maximum number of results to return
    """
    return json.dumps(results)
```

### Class Approach (for complex tools)

```python
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

class SearchInput(BaseModel):
    query: str = Field(description="Search terms")
    limit: int = Field(default=10, description="Max results")

class SearchDatabaseTool(BaseTool):
    name: str = "search_database"
    description: str = "Search the database for records matching the query"
    args_schema: type[BaseModel] = SearchInput

    def _run(self, query: str, limit: int = 10) -> str:
        return json.dumps(results)

    async def _arun(self, query: str, limit: int = 10) -> str:
        return json.dumps(await async_search(query, limit))
```

**Key details**:
- Docstrings and `Field(description=...)` drive the LLM's understanding of each parameter
- Type hints are mandatory: LangChain generates JSON schemas from them
- `_run` for sync, `_arun` for async
- LangGraph (production-grade) adds stateful graphs, human-in-the-loop, and time-travel debugging
- Tools can be loaded from MCP servers via `langchain-mcp-adapters`

---

## 4. CrewAI Tools

**What**: Multi-agent framework. Tools extend what agents can do.

### Decorator Approach

```python
from crewai.tools import tool

@tool("Search Database")
def search_database(query: str) -> str:
    """Search the database for records matching the query."""
    return json.dumps(results)
```

### Class Approach

```python
from crewai.tools import BaseTool
from pydantic import BaseModel, Field
from typing import Type

class SearchInput(BaseModel):
    query: str = Field(..., description="Search terms")

class SearchDatabaseTool(BaseTool):
    name: str = "Search Database"
    description: str = "Search the database for records matching the query"
    args_schema: Type[BaseModel] = SearchInput

    def _run(self, query: str) -> str:
        return json.dumps(results)
```

**Key details**:
- Pydantic `args_schema` provides automatic input validation
- Tools support caching to avoid redundant external calls
- Assign tools to agents: `Agent(tools=[SearchDatabaseTool()])`
- Supports async via `_arun()` alongside `_run()`

---

## 5. Microsoft AutoGen / Agent Framework

**What**: Multi-agent conversation framework. FunctionTool wraps Python functions.

```python
from autogen_core.tools import FunctionTool

async def search_database(query: str, limit: int = 10) -> str:
    """Search the database for records matching the query."""
    return json.dumps(results)

search_tool = FunctionTool(search_database, description="Search database records")
```

**Key details**:
- AutoGen v0.4: async-first, event-driven architecture
- Microsoft Agent Framework (successor) merges AutoGen + Semantic Kernel
- `FunctionTool` uses docstrings and type annotations for LLM schema generation
- Tools are registered with agents via `tools=[search_tool]` parameter

---

## 6. Agent-to-Agent Protocols

### Google A2A (Agent2Agent Protocol)

For when you want YOUR agent to be discoverable and callable by OTHER agents.

**Agent Card** (JSON at `/.well-known/agent.json`):
```json
{
  "name": "Database Search Agent",
  "description": "Searches enterprise databases",
  "url": "https://my-agent.example.com",
  "version": "1.0.0",
  "capabilities": {
    "streaming": true,
    "pushNotifications": false
  },
  "skills": [
    {
      "id": "search",
      "name": "Database Search",
      "description": "Full-text search across all databases"
    }
  ],
  "authentication": {
    "schemes": ["bearer"]
  }
}
```

**Communication**: JSON-RPC 2.0 over HTTPS. Task lifecycle: submitted -> working -> completed/failed.
**Transport options**: Sync (request/response), streaming (SSE), async (push notifications via webhook).
**Current version**: 0.3 under Linux Foundation. gRPC support added.

### ACP (Agent Communication Protocol)

IBM's open standard. RESTful HTTP-based. Simpler than A2A.
- Standard HTTP verbs for task management
- Works with `curl` and Postman out of the box
- Python and TypeScript SDKs available

### ANP (Agent Network Protocol)

Decentralized, peer-to-peer. For open internet agent discovery.
- Agents find each other via structured metadata
- DID-based authentication
- More experimental, less adopted

---

## Universal Design Principles for Agent-Usable Apps

### 1. Schema-First Design
Every tool/function MUST have a JSON Schema for its inputs. All major frameworks generate this from type hints, but you should understand the underlying schema:

```json
{
  "type": "object",
  "properties": {
    "param_name": {
      "type": "string",
      "description": "What this parameter does and when to use it"
    }
  },
  "required": ["param_name"],
  "additionalProperties": false
}
```

### 2. Descriptions Are the API Contract
The LLM decides whether and how to use your tool based ENTIRELY on:
- The tool name (make it verb_noun: `search_users`, `create_ticket`)
- The tool description (say WHEN to use it, not just what it does)
- Parameter descriptions (include valid values, formats, constraints)

Bad: `"description": "Searches the database"`
Good: `"description": "Search the user database by name, email, or ID. Use this when the user asks to find or look up a person. Returns up to 'limit' matching user records as JSON."`

### 3. Return Structured Text
- Return JSON strings for structured data
- Return plain text for narrative/summary responses
- Never return raw binary data; use base64 or URLs
- Include enough context in the response for the LLM to interpret results without calling another tool

### 4. Error Handling
- Return errors as descriptive text, not exceptions (exceptions kill the agent loop)
- Include what went wrong AND how to fix it: `"No user found with email 'x'. Try searching by name instead."`
- HTTP APIs: use standard status codes + descriptive error bodies

### 5. Idempotency and Safety
- Mark read-only tools differently from write tools (MCP has `readOnlyHint`)
- Destructive operations should require confirmation (MCP supports `confirmationHint`)
- Design tools to be safely retryable (agents often retry on ambiguous failures)

### 6. Granularity
- Each tool does ONE thing. Don't make a `manage_database` mega-tool.
- Keep parameter count under 5. Group related params into a single object if needed.
- Total tools per server/agent: keep under 20. More than that degrades LLM tool selection.

### 7. Making REST APIs Agent-Friendly
If you have an existing REST API and want agents to use it:
1. **Add an OpenAPI spec** with detailed descriptions for every endpoint, parameter, and response
2. **Wrap it as an MCP server** (most universal). Use the OpenAPI spec to auto-generate tools.
3. **Or wrap it as function definitions** for OpenAI/LangChain directly
4. **Use consistent naming**: `GET /users/{id}` -> tool name `get_user`
5. **Return machine-readable errors** with context, not just status codes
6. **Paginate by default** and let agents request specific pages

---

## Quick Reference: Which Protocol to Use

| Your Goal | Use This |
|-----------|----------|
| Make a tool any LLM client can use | **MCP server** (widest adoption) |
| Build tools for OpenAI models specifically | **Function calling** (JSON schema tools) |
| Build tools within a LangChain/LangGraph app | **LangChain @tool decorator** |
| Build tools for a CrewAI multi-agent system | **CrewAI BaseTool / @tool** |
| Build tools for AutoGen agents | **FunctionTool wrapper** |
| Make your agent callable by other agents | **A2A Agent Card** + JSON-RPC |
| Wrap an existing REST API for agents | **MCP server** wrapping your OpenAPI spec |

## Cross-Framework Compatibility

The pattern is converging. All frameworks use the same underlying structure:
1. A **name** (string, snake_case preferred)
2. A **description** (natural language, tells the LLM when/how to use it)
3. A **JSON Schema** for parameters (generated from type hints in most frameworks)
4. A **callable** that executes and returns text

If you build an MCP server, most frameworks can consume it directly or via adapters. MCP is the closest thing to a universal standard as of 2026.
