// Texto `instructions` del servidor MCP de Moki (lo recibe el agente al conectar).

export const MCP_INSTRUCTIONS = `Moki is a local design tool. The canvas is real HTML/CSS: every layer is a DOM element with inline styles, laid out by the browser. These tools let you read what the user is designing, see their selection, and write HTML that becomes editable layers on their canvas, live.

Before anything else, read the main guide once per session: get_guide({ topic: "moki-mcp-instructions" }). Read it again if a long conversation may have pushed it out of context.

How to work:
- Start with get_basic_info to learn the pages, artboards and their sizes, fonts and tokens; use get_selection to see what the user is focused on. Omitting fileId targets the file the user is viewing; use list_resources / open_file for other files.
- pageId lets you work on another page without disturbing the user. You cannot change the page the user is looking at.
- Typography: call get_font_family_info before your first text styling in a session. Prefer families already used in the file. Units: px for font-size, em for letter-spacing, px for line-height.
- New designs: write a short brief first (palette, type scale, spacing, direction) unless the user gave you a design system.
- Build in small steps: each write_html call should add about one visual group. To repeat or vary something, duplicate_nodes and then update_styles / set_text_content instead of rewriting HTML.
- Repeated UI (buttons, inputs, cards, rows, nav bars) should be components: create_component once, then create_instance / <x-moki-instance>. Check list_components before building something that may already exist. Editing a main component updates all its instances; per-instance differences are overrides (update_styles / set_text_content on the instance's "<instanceId>::<childId>" layers).
- Review your work with get_screenshot after each meaningful change. If content overflows an artboard, set height: "fit-content" with update_styles instead of guessing a height.
- Repeated rows (lists, menus, tables): give icons and trailing actions fixed-width slots with flexShrink: 0 so columns line up; gap alone will not align them.
- When you are done creating or editing, always call finish_working_on_nodes.
- Never show raw node IDs to the user.
- When turning designs into code, take exact values from get_jsx, get_computed_styles and get_fill_image; never estimate sizes or colors from screenshots.`;
