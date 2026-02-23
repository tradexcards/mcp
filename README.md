# TradeX MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server that enables AI agents to research, analyze, and trade Pokemon card perpetual futures on the TradeX platform.

**npm:** [@tradex/mcp](https://www.npmjs.com/package/@tradex/mcp)  
**Source:** [GitHub](https://github.com/tradexcards/mcp)

## Installation

> **Security**: Use a dedicated trading wallet with only the funds you intend to trade.
> Your keypair never leaves your machine - all signing is done locally.

### Claude Code

```bash
claude mcp add tradex -- npx -y @tradex/mcp
```

For trade execution, pass your keypair:

```bash
claude mcp add tradex -e TRADEX_KEYPAIR=/path/to/keypair.json -- npx -y @tradex/mcp
```

Omit `TRADEX_KEYPAIR` for read-only mode (search cards, check prices, no trading).

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

**Read-only mode:**
```json
{
  "mcpServers": {
    "tradex": {
      "command": "npx",
      "args": ["-y", "@tradex/mcp"]
    }
  }
}
```

**With trade execution:**
```json
{
  "mcpServers": {
    "tradex": {
      "command": "npx",
      "args": ["-y", "@tradex/mcp"],
      "env": {
        "TRADEX_KEYPAIR": "/path/to/your/keypair.json"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "tradex": {
      "command": "npx",
      "args": ["-y", "@tradex/mcp"]
    }
  }
}
```

## Environment Variables

| Variable            | Description                 | Default                               |
| ------------------- | --------------------------- | ------------------------------------- |
| `TRADEX_KEYPAIR` | Path to Solana keypair JSON | (none - read-only)                    |
| `TRADEX_API_URL` | Backend API URL             | `https://backend.tradex.cards`       |
| `TRADEX_RPC_URL` | Solana RPC URL              | `https://api.mainnet-beta.solana.com` |

## Tools

### Read-Only (always available)

| Tool                    | Description                                  |
| ----------------------- | -------------------------------------------- |
| `get_market_movers`     | Top gainers, losers, and most volatile cards |
| `get_portfolio`         | Complete portfolio with computed PnL         |
| `get_trading_signals`   | Trading signals and recommendations          |
| `prepare_trade`         | Validate a trade before execution            |
| `simulate_trade`        | Simulate trade with PnL scenarios            |
| `search_cards`          | Search Pokemon cards by name                 |
| `get_card_details`      | Detailed card info with price history        |
| `batch_get_cards`       | Fetch multiple cards at once                 |
| `get_tradable_products` | List all tradable product IDs                |
| `get_trading_config`    | Trading parameters (leverage, fees)          |

### Execution (require keypair)

| Tool                | Description                        |
| ------------------- | ---------------------------------- |
| `open_position`     | Open a long/short position         |
| `close_position`    | Close an existing position         |
| `deposit`           | Deposit USDC into trading account  |
| `withdraw`          | Withdraw USDC from trading account |
| `get_wallet_status` | Check wallet balance and status    |

## Resources

The server provides documentation resources:

- `tradex://docs/trading-guide` - Trading guide and best practices
- `tradex://docs/api-reference` - OpenAPI specification

## Example Usage

Once installed, ask Claude:

**Research:**
- "What are the biggest movers in Pokemon cards today?"
- "Show me trading signals for Charizard cards"
- "Simulate a $100 long position on product 517044 with 5x leverage"

**Trading (with keypair):**
- "Check my wallet status"
- "Deposit $50 USDC into my trading account"
- "Open a $20 long position on Charizard with 3x leverage"
- "Close my position on product 517044"

## Security

- Private keys are stored locally and never transmitted
- Transactions are signed locally using `@solana/web3.js`
- All trades are validated before execution
- Transaction parameters fetched from the TradeX backend

## API Endpoints

The MCP server connects to:

| Resource          | URL                                         |
| ----------------- | ------------------------------------------- |
| Backend API       | https://backend.tradex.cards               |
| API Documentation | https://tradex.cards/docs                  |
| OpenAPI Spec      | https://backend.tradex.cards/api/docs/json |
| Trading Guide     | https://tradex.cards/SKILL.md              |

## Development

```bash
# Install dependencies
bun install

# Build
bun run build

# Run locally
bun run dev
```

## License

Business Source License 1.1 (BUSL-1.1), non-commercial use only.
Automatically changes to GNU GPLv3 on 2030-02-18.
# mcp
