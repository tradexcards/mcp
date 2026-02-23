#!/usr/bin/env node
/**
 * TradeX MCP Server
 * 
 * A Model Context Protocol server that enables AI agents to trade
 * Pokemon card perpetuals on the TradeX platform.
 * 
 * Install: npx @tradex/mcp-server
 * Or add to Claude Desktop config.
 * 
 * Environment variables:
 *   TRADEX_API_URL     - Backend API URL (default: https://backend.tradex.cards)
 *   TRADEX_KEYPAIR     - Path to Solana keypair JSON file (enables trade execution)
 *   TRADEX_RPC_URL     - Solana RPC URL (default: mainnet-beta)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  TransactionInstruction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { readFileSync, existsSync } from "fs";

// ============================================================================
// Configuration
// ============================================================================

const API_BASE = process.env.TRADEX_API_URL || "https://backend.tradex.cards";
const KEYPAIR_PATH = process.env.TRADEX_KEYPAIR;
const RPC_URL = process.env.TRADEX_RPC_URL || "https://api.mainnet-beta.solana.com";

const PROGRAM_ID = new PublicKey("TRDXCHHWWZdQXxkGFJxek1KU2hn19687xztNBy99Ca1");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const ED25519_PROGRAM = new PublicKey("Ed25519SigVerify111111111111111111111111111");
const SYSVAR_INSTRUCTIONS = new PublicKey("Sysvar1nstructions1111111111111111111111111");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");

const DISCRIMINATORS: Record<string, number[]> = {
  createUserAccount: [146, 68, 100, 69, 63, 46, 182, 199],
  deposit: [242, 35, 198, 137, 82, 225, 242, 182],
  withdraw: [183, 18, 70, 156, 148, 109, 161, 34],
  openPosition: [135, 128, 47, 77, 15, 152, 240, 49],
  closePosition: [123, 134, 81, 0, 49, 68, 98, 98],
};

// ============================================================================
// Wallet Management
// ============================================================================

let wallet: Keypair | null = null;
let connection: Connection | null = null;

function loadWallet(): Keypair | null {
  if (!KEYPAIR_PATH) return null;
  if (!existsSync(KEYPAIR_PATH)) {
    console.error(`[warn] Keypair file not found: ${KEYPAIR_PATH}`);
    return null;
  }
  try {
    const data = JSON.parse(readFileSync(KEYPAIR_PATH, "utf-8"));
    return Keypair.fromSecretKey(Uint8Array.from(data));
  } catch (error) {
    console.error(`[warn] Failed to load keypair: ${error}`);
    return null;
  }
}

function isTradeEnabled(): boolean {
  return wallet !== null;
}

function getWalletAddress(): string | null {
  return wallet?.publicKey.toString() || null;
}

// ============================================================================
// Solana Helpers
// ============================================================================

function derivePDA(seeds: Buffer[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
}

function u32LE(n: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(n);
  return buf;
}

function buildEd25519Ix(pubkey: Uint8Array, signature: Uint8Array, message: Uint8Array): TransactionInstruction {
  const msgLen = message.length;
  const data = new Uint8Array(112 + msgLen);
  const view = new DataView(data.buffer);
  let off = 0;
  data[off++] = 1;
  data[off++] = 0;
  view.setUint16(off, 48, true); off += 2;
  view.setUint16(off, 0xFFFF, true); off += 2;
  view.setUint16(off, 16, true); off += 2;
  view.setUint16(off, 0xFFFF, true); off += 2;
  view.setUint16(off, 112, true); off += 2;
  view.setUint16(off, msgLen, true); off += 2;
  view.setUint16(off, 0xFFFF, true); off += 2;
  data.set(pubkey, 16);
  data.set(signature, 48);
  data.set(message, 112);
  return new TransactionInstruction({ programId: ED25519_PROGRAM, keys: [], data: Buffer.from(data) });
}

async function buildAndSendTransaction(instructions: TransactionInstruction[]): Promise<string> {
  if (!wallet || !connection) throw new Error("Wallet not configured");
  
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(msg);
  tx.sign([wallet]);

  const signature = await connection.sendTransaction(tx);
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight });

  return signature;
}

// ============================================================================
// API Helper
// ============================================================================

async function apiCall<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const url = `${API_BASE}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(`API Error: ${error.error || response.statusText}`);
  }
  
  return response.json();
}

// ============================================================================
// Tool Definitions
// ============================================================================

const READ_ONLY_TOOLS = [
  {
    name: "get_market_movers",
    description: "Get top gainers, losers, and most volatile Pokemon cards. Use this to find trading opportunities.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Number of cards per category (default: 10, max: 50)" },
      },
    },
  },
  {
    name: "get_portfolio",
    description: "Get complete portfolio for a wallet including account balance, all positions with computed PnL, and summary metrics.",
    inputSchema: {
      type: "object" as const,
      properties: {
        wallet: { type: "string", description: "Solana wallet address (optional if keypair configured)" },
      },
    },
  },
  {
    name: "get_trading_signals",
    description: "Get pre-computed trading signals for a card including momentum, mean reversion, supply pressure, and a composite recommendation.",
    inputSchema: {
      type: "object" as const,
      properties: {
        productId: { type: "number", description: "TCGPlayer product ID" },
      },
      required: ["productId"],
    },
  },
  {
    name: "prepare_trade",
    description: "Validate if a trade can be placed and simulate margin/fees. Always call this before opening a position.",
    inputSchema: {
      type: "object" as const,
      properties: {
        productId: { type: "number", description: "TCGPlayer product ID" },
        side: { type: "string", enum: ["long", "short"], description: "Trade direction" },
        size: { type: "number", description: "Position size in USD (min: $1, max: $100,000)" },
        leverage: { type: "number", description: "Leverage multiplier (1-50)" },
      },
      required: ["productId"],
    },
  },
  {
    name: "simulate_trade",
    description: "Simulate a trade to see margin requirements, fees, liquidation price, break-even, and PnL scenarios.",
    inputSchema: {
      type: "object" as const,
      properties: {
        productId: { type: "number", description: "TCGPlayer product ID" },
        side: { type: "string", enum: ["long", "short"], description: "Trade direction" },
        size: { type: "number", description: "Position size in USD" },
        leverage: { type: "number", description: "Leverage multiplier (1-50)" },
      },
      required: ["productId", "side", "size", "leverage"],
    },
  },
  {
    name: "search_cards",
    description: "Search for Pokemon cards by name.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (min 2 characters)" },
        limit: { type: "number", description: "Max results (default: 20, max: 50)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_card_details",
    description: "Get detailed information about a specific card including price history, listings, and analysis.",
    inputSchema: {
      type: "object" as const,
      properties: {
        productId: { type: "number", description: "TCGPlayer product ID" },
      },
      required: ["productId"],
    },
  },
  {
    name: "batch_get_cards",
    description: "Fetch data for multiple cards in a single request (up to 50 cards).",
    inputSchema: {
      type: "object" as const,
      properties: {
        productIds: { type: "array", items: { type: "number" }, description: "Array of TCGPlayer product IDs (max 50)" },
        include: { type: "array", items: { type: "string" }, description: "Data to include: analysis, listings, sales, history" },
      },
      required: ["productIds"],
    },
  },
  {
    name: "get_tradable_products",
    description: "Get list of all product IDs that have active trading markets.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "get_trading_config",
    description: "Get trading configuration including max leverage, fees, and minimum position size.",
    inputSchema: { type: "object" as const, properties: {} },
  },
];

const EXECUTION_TOOLS = [
  {
    name: "open_position",
    description: "Open a new trading position. Requires TRADEX_KEYPAIR to be configured.",
    inputSchema: {
      type: "object" as const,
      properties: {
        productId: { type: "number", description: "TCGPlayer product ID" },
        side: { type: "string", enum: ["long", "short"], description: "Trade direction" },
        size: { type: "number", description: "Position size in USD (min: $1, max: $100,000)" },
        leverage: { type: "number", description: "Leverage multiplier (1-50)" },
      },
      required: ["productId", "side", "size", "leverage"],
    },
  },
  {
    name: "close_position",
    description: "Close an existing position to realize PnL. Requires TRADEX_KEYPAIR to be configured.",
    inputSchema: {
      type: "object" as const,
      properties: {
        productId: { type: "number", description: "TCGPlayer product ID of the position to close" },
      },
      required: ["productId"],
    },
  },
  {
    name: "deposit",
    description: "Deposit USDC into trading account. Requires TRADEX_KEYPAIR to be configured.",
    inputSchema: {
      type: "object" as const,
      properties: {
        amount: { type: "number", description: "Amount in USD to deposit" },
      },
      required: ["amount"],
    },
  },
  {
    name: "withdraw",
    description: "Withdraw USDC from trading account. Requires TRADEX_KEYPAIR to be configured.",
    inputSchema: {
      type: "object" as const,
      properties: {
        amount: { type: "number", description: "Amount in USD to withdraw" },
      },
      required: ["amount"],
    },
  },
  {
    name: "get_wallet_status",
    description: "Check if trade execution is enabled and get wallet balance.",
    inputSchema: { type: "object" as const, properties: {} },
  },
];

// ============================================================================
// Tool Handlers
// ============================================================================

interface SignedPrice {
  price: string;
  timestamp: number;
  signature: string;
  publicKey: string;
  message: string;
}

interface TxParams {
  params: { accounts: Record<string, string>; args: Record<string, unknown> };
  signedPrice?: SignedPrice;
}

async function handleTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    // ── Read-Only Tools ────────────────────────────────────────────────────
    case "get_market_movers": {
      const limit = (args.limit as number) || 10;
      const data = await apiCall(`/api/trading/analytics/movers?limit=${limit}`);
      return JSON.stringify(data, null, 2);
    }

    case "get_portfolio": {
      const walletAddr = (args.wallet as string) || getWalletAddress();
      if (!walletAddr) {
        return JSON.stringify({ error: "No wallet address provided and TRADEX_KEYPAIR not configured" }, null, 2);
      }
      const data = await apiCall(`/api/trading/portfolio/${walletAddr}`);
      return JSON.stringify(data, null, 2);
    }

    case "get_trading_signals": {
      const productId = args.productId as number;
      const data = await apiCall(`/api/cards/${productId}/signals`);
      return JSON.stringify(data, null, 2);
    }

    case "prepare_trade": {
      const { productId, side, size, leverage } = args;
      const walletAddr = getWalletAddress();
      const params = new URLSearchParams();
      if (walletAddr) params.set("wallet", walletAddr);
      if (side) params.set("side", side as string);
      if (size) params.set("size", String(size));
      if (leverage) params.set("leverage", String(leverage));
      const query = params.toString() ? `?${params.toString()}` : "";
      const data = await apiCall(`/api/trading/prepare-trade/${productId}${query}`);
      return JSON.stringify(data, null, 2);
    }

    case "simulate_trade": {
      const data = await apiCall("/api/trading/simulate", { method: "POST", body: JSON.stringify(args) });
      return JSON.stringify(data, null, 2);
    }

    case "search_cards": {
      const { query, limit = 20 } = args;
      const data = await apiCall(`/api/cards/search?q=${encodeURIComponent(query as string)}&limit=${limit}`);
      return JSON.stringify(data, null, 2);
    }

    case "get_card_details": {
      const productId = args.productId as number;
      const data = await apiCall(`/api/cards/${productId}/bundle?include_listings=true&include_sales=true&include_history=true`);
      return JSON.stringify(data, null, 2);
    }

    case "batch_get_cards": {
      const data = await apiCall("/api/cards/batch", { method: "POST", body: JSON.stringify(args) });
      return JSON.stringify(data, null, 2);
    }

    case "get_tradable_products": {
      const data = await apiCall("/api/trading/tradable");
      return JSON.stringify(data, null, 2);
    }

    case "get_trading_config": {
      const data = await apiCall("/api/trading/config");
      return JSON.stringify(data, null, 2);
    }

    // ── Execution Tools ────────────────────────────────────────────────────
    case "get_wallet_status": {
      if (!isTradeEnabled()) {
        return JSON.stringify({
          enabled: false,
          message: "Trade execution disabled. Set TRADEX_KEYPAIR environment variable.",
        }, null, 2);
      }
      
      const balance = await connection!.getBalance(wallet!.publicKey);
      const usdcAccount = getAssociatedTokenAddressSync(USDC_MINT, wallet!.publicKey);
      let usdcBalance = 0;
      try {
        const tokenBalance = await connection!.getTokenAccountBalance(usdcAccount);
        usdcBalance = parseFloat(tokenBalance.value.uiAmountString || "0");
      } catch { /* Token account may not exist */ }

      return JSON.stringify({
        enabled: true,
        wallet: wallet!.publicKey.toString(),
        balance: { sol: balance / 1e9, usdc: usdcBalance },
      }, null, 2);
    }

    case "open_position": {
      if (!isTradeEnabled()) {
        return JSON.stringify({ success: false, error: "Trade execution disabled. Set TRADEX_KEYPAIR." }, null, 2);
      }

      const { productId, side, size, leverage } = args;
      
      // Validate first
      const validation = await apiCall<{ canTrade: boolean; errors: string[] }>(
        `/api/trading/prepare-trade/${productId}?wallet=${wallet!.publicKey}&side=${side}&size=${size}&leverage=${leverage}`
      );
      if (!validation.canTrade) {
        return JSON.stringify({ success: false, error: "Trade validation failed", reasons: validation.errors }, null, 2);
      }

      // Get transaction params
      const txData = await apiCall<TxParams>("/api/trading/tx/open-position", {
        method: "POST",
        body: JSON.stringify({ owner: wallet!.publicKey.toString(), productId, side, size, leverage }),
      });

      const { params, signedPrice } = txData;
      if (!signedPrice) {
        return JSON.stringify({ success: false, error: "No signed price returned" }, null, 2);
      }

      // Build Ed25519 instruction
      const sigBytes = Uint8Array.from(atob(signedPrice.signature), c => c.charCodeAt(0));
      const pubBytes = Uint8Array.from(atob(signedPrice.publicKey), c => c.charCodeAt(0));
      const msgBytes = Uint8Array.from(atob(signedPrice.message), c => c.charCodeAt(0));
      const ed25519Ix = buildEd25519Ix(pubBytes, sigBytes, msgBytes);

      // Build openPosition instruction
      const ixData = new Uint8Array(41);
      const ixView = new DataView(ixData.buffer);
      let off = 0;
      ixData.set(DISCRIMINATORS.openPosition, off); off += 8;
      ixView.setUint32(off, params.args.productId as number, true); off += 4;
      ixView.setUint8(off, params.args.side as number); off += 1;
      ixView.setBigUint64(off, BigInt(params.args.size as string), true); off += 8;
      ixView.setUint32(off, params.args.leverage as number, true); off += 4;
      ixView.setBigUint64(off, BigInt(signedPrice.price), true); off += 8;
      ixView.setBigInt64(off, BigInt(signedPrice.timestamp), true);

      const expectedUA = derivePDA([Buffer.from("user_account"), wallet!.publicKey.toBuffer()]);
      const expectedPos = derivePDA([Buffer.from("position"), wallet!.publicKey.toBuffer(), u32LE(productId as number)]);
      const expectedMarket = derivePDA([Buffer.from("market"), u32LE(productId as number)]);

      const tradeIx = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: expectedUA, isWritable: true, isSigner: false },
          { pubkey: expectedPos, isWritable: true, isSigner: false },
          { pubkey: expectedMarket, isWritable: true, isSigner: false },
          { pubkey: new PublicKey(params.accounts.exchangeState), isWritable: true, isSigner: false },
          { pubkey: new PublicKey(params.accounts.oracleState), isWritable: false, isSigner: false },
          { pubkey: wallet!.publicKey, isWritable: true, isSigner: true },
          { pubkey: SYSTEM_PROGRAM, isWritable: false, isSigner: false },
          { pubkey: SYSVAR_INSTRUCTIONS, isWritable: false, isSigner: false },
        ],
        data: Buffer.from(ixData),
      });

      const signature = await buildAndSendTransaction([ed25519Ix, tradeIx]);
      return JSON.stringify({ success: true, signature, explorer: `https://solscan.io/tx/${signature}` }, null, 2);
    }

    case "close_position": {
      if (!isTradeEnabled()) {
        return JSON.stringify({ success: false, error: "Trade execution disabled. Set TRADEX_KEYPAIR." }, null, 2);
      }

      const { productId } = args;

      const txData = await apiCall<TxParams>("/api/trading/tx/close-position", {
        method: "POST",
        body: JSON.stringify({ owner: wallet!.publicKey.toString(), productId }),
      });

      const { params, signedPrice } = txData;
      if (!signedPrice) {
        return JSON.stringify({ success: false, error: "No signed price returned" }, null, 2);
      }

      const sigBytes = Uint8Array.from(atob(signedPrice.signature), c => c.charCodeAt(0));
      const pubBytes = Uint8Array.from(atob(signedPrice.publicKey), c => c.charCodeAt(0));
      const msgBytes = Uint8Array.from(atob(signedPrice.message), c => c.charCodeAt(0));
      const ed25519Ix = buildEd25519Ix(pubBytes, sigBytes, msgBytes);

      const ixData = new Uint8Array(28);
      const ixView = new DataView(ixData.buffer);
      let off = 0;
      ixData.set(DISCRIMINATORS.closePosition, off); off += 8;
      ixView.setUint32(off, productId as number, true); off += 4;
      ixView.setBigUint64(off, BigInt(signedPrice.price), true); off += 8;
      ixView.setBigInt64(off, BigInt(signedPrice.timestamp), true);

      const expectedUA = derivePDA([Buffer.from("user_account"), wallet!.publicKey.toBuffer()]);
      const expectedPos = derivePDA([Buffer.from("position"), wallet!.publicKey.toBuffer(), u32LE(productId as number)]);
      const expectedMarket = derivePDA([Buffer.from("market"), u32LE(productId as number)]);

      const tradeIx = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: expectedUA, isWritable: true, isSigner: false },
          { pubkey: expectedPos, isWritable: true, isSigner: false },
          { pubkey: expectedMarket, isWritable: true, isSigner: false },
          { pubkey: new PublicKey(params.accounts.exchangeState), isWritable: true, isSigner: false },
          { pubkey: new PublicKey(params.accounts.vault), isWritable: true, isSigner: false },
          { pubkey: new PublicKey(params.accounts.insuranceFund), isWritable: true, isSigner: false },
          { pubkey: new PublicKey(params.accounts.oracleState), isWritable: false, isSigner: false },
          { pubkey: wallet!.publicKey, isWritable: true, isSigner: true },
          { pubkey: TOKEN_PROGRAM, isWritable: false, isSigner: false },
          { pubkey: SYSVAR_INSTRUCTIONS, isWritable: false, isSigner: false },
        ],
        data: Buffer.from(ixData),
      });

      const signature = await buildAndSendTransaction([ed25519Ix, tradeIx]);
      return JSON.stringify({ success: true, signature, explorer: `https://solscan.io/tx/${signature}` }, null, 2);
    }

    case "deposit": {
      if (!isTradeEnabled()) {
        return JSON.stringify({ success: false, error: "Trade execution disabled. Set TRADEX_KEYPAIR." }, null, 2);
      }

      const { amount } = args;
      const userTokenAccount = getAssociatedTokenAddressSync(USDC_MINT, wallet!.publicKey);

      const txData = await apiCall<TxParams>("/api/trading/tx/deposit", {
        method: "POST",
        body: JSON.stringify({ owner: wallet!.publicKey.toString(), userTokenAccount: userTokenAccount.toString(), amount }),
      });

      const { params } = txData;
      const amountBaseUnits = BigInt(params.args.amount as string);

      const data = new Uint8Array(16);
      data.set(DISCRIMINATORS.deposit);
      new DataView(data.buffer).setBigUint64(8, amountBaseUnits, true);

      const ix = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: new PublicKey(params.accounts.userAccount), isWritable: true, isSigner: false },
          { pubkey: new PublicKey(params.accounts.exchangeState), isWritable: true, isSigner: false },
          { pubkey: new PublicKey(params.accounts.vault), isWritable: true, isSigner: false },
          { pubkey: userTokenAccount, isWritable: true, isSigner: false },
          { pubkey: wallet!.publicKey, isWritable: true, isSigner: true },
          { pubkey: TOKEN_PROGRAM, isWritable: false, isSigner: false },
        ],
        data: Buffer.from(data),
      });

      const signature = await buildAndSendTransaction([ix]);
      return JSON.stringify({ success: true, signature, explorer: `https://solscan.io/tx/${signature}` }, null, 2);
    }

    case "withdraw": {
      if (!isTradeEnabled()) {
        return JSON.stringify({ success: false, error: "Trade execution disabled. Set TRADEX_KEYPAIR." }, null, 2);
      }

      const { amount } = args;
      const userTokenAccount = getAssociatedTokenAddressSync(USDC_MINT, wallet!.publicKey);

      const txData = await apiCall<TxParams>("/api/trading/tx/withdraw", {
        method: "POST",
        body: JSON.stringify({ owner: wallet!.publicKey.toString(), userTokenAccount: userTokenAccount.toString(), amount }),
      });

      const { params } = txData;
      const amountBaseUnits = BigInt(params.args.amount as string);

      const data = new Uint8Array(16);
      data.set(DISCRIMINATORS.withdraw);
      new DataView(data.buffer).setBigUint64(8, amountBaseUnits, true);

      const ix = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: new PublicKey(params.accounts.userAccount), isWritable: true, isSigner: false },
          { pubkey: new PublicKey(params.accounts.exchangeState), isWritable: true, isSigner: false },
          { pubkey: new PublicKey(params.accounts.vault), isWritable: true, isSigner: false },
          { pubkey: userTokenAccount, isWritable: true, isSigner: false },
          { pubkey: wallet!.publicKey, isWritable: true, isSigner: true },
          { pubkey: TOKEN_PROGRAM, isWritable: false, isSigner: false },
        ],
        data: Buffer.from(data),
      });

      const signature = await buildAndSendTransaction([ix]);
      return JSON.stringify({ success: true, signature, explorer: `https://solscan.io/tx/${signature}` }, null, 2);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ============================================================================
// MCP Server
// ============================================================================

const server = new Server(
  { name: "tradex", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} } }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...READ_ONLY_TOOLS, ...EXECUTION_TOOLS],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  try {
    const result = await handleTool(name, args as Record<string, unknown>);
    return { content: [{ type: "text", text: result }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
});

// List resources
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    { uri: "tradex://docs/trading-guide", name: "TradeX Trading Guide", mimeType: "text/markdown" },
    { uri: "tradex://docs/api-reference", name: "API Reference", mimeType: "application/json" },
  ],
}));

// Read resources
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  if (uri === "tradex://docs/trading-guide") {
    const guide = `# TradeX Trading Guide

## Overview
TradeX is a decentralized perpetual futures exchange for Pokemon TCG card prices on Solana.

## Trading Parameters
- Max leverage: 50x
- Min position size: $1 USDC
- Max position per user: $100,000 USDC
- Trading fee: 0.05% (5 bps) on open and close
- Maintenance margin: 1% (100 bps)

## Workflow
1. Use \`get_market_movers\` to find opportunities
2. Use \`get_trading_signals\` to analyze a specific card
3. Use \`prepare_trade\` to validate before opening
4. If canTrade=true, use \`open_position\` to execute

## Trade Execution Setup
To enable trade execution, set TRADEX_KEYPAIR to your Solana keypair path:

\`\`\`json
{
  "mcpServers": {
    "tradex": {
      "command": "npx",
      "args": ["@tradex/mcp"],
      "env": {
        "TRADEX_KEYPAIR": "/path/to/keypair.json"
      }
    }
  }
}
\`\`\`

## Risk Management
- Always check \`distanceToLiquidation\` before trading
- Monitor \`riskStatus\` in portfolio: safe (>5%), warning (2-5%), danger (<2%)

## Tools
- Read-only: get_market_movers, get_portfolio, get_trading_signals, prepare_trade, simulate_trade, search_cards, get_card_details, batch_get_cards, get_tradable_products, get_trading_config
- Execution: open_position, close_position, deposit, withdraw, get_wallet_status
`;
    return { contents: [{ uri, mimeType: "text/markdown", text: guide }] };
  }

  if (uri === "tradex://docs/api-reference") {
    const spec = await apiCall("/api/docs/json");
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(spec, null, 2) }] };
  }

  throw new Error(`Unknown resource: ${uri}`);
});

// ============================================================================
// Main
// ============================================================================

async function main() {
  // Initialize wallet if configured
  wallet = loadWallet();
  if (wallet) {
    connection = new Connection(RPC_URL, "confirmed");
    console.error(`TradeX MCP Server (trade execution enabled)`);
    console.error(`  Wallet: ${wallet.publicKey.toString()}`);
  } else {
    console.error(`TradeX MCP Server (read-only mode)`);
    console.error(`  Set TRADEX_KEYPAIR to enable trade execution`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
