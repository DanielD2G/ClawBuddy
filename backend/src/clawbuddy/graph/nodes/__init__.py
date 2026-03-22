"""Agent graph nodes — individual processing steps.

Each node handles a specific part of the agent's processing pipeline:
- llm_call: LLM invocation, token recording, overlap detection
- tool_execution: Tool call routing and execution
- tool_approval: Permission checking and approval flow
- context_compression: History summarization
- tool_discovery: Pre-flight semantic tool discovery
- result_processing: Output truncation, screenshot extraction
- save_message: DB persistence of messages and state
- title_generation: Session title generation
"""
