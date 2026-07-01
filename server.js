const express = require('express');
const { Client } = require('pg');
const path = require('path');

const app = express();
const PORT = 3456;

const DB_URL = 'postgresql://phil-protocol:0c543e1395eeac5472f88b1ca3ab4aff4332d61b@jj2z4gi11m.nzntsgg3g9.tsdb.cloud.timescale.com:34378/tsdb?sslmode=require';
const S = '"prod-protocol"';

// user_id -> treasury_id mapping (treasury_id = user_id + 1 for these accounts)
const ACCOUNTS = {
  MasterOfTheGame: { wallet: '0x5eF2bf29B6BeC2A4F703aF938dDaC5E22dd9447A', user_id: 398, treasury_id: 399 },
  MrKrabs:         { wallet: '0xFAc19fC789761642C237900541e3b272b471BD31', user_id: 399, treasury_id: 400 },
};

async function query(sql, params = []) {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows;
  } finally {
    await client.end();
  }
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/data', async (req, res) => {
  try {
    const userIds = Object.values(ACCOUNTS).map(a => a.user_id);
    const treasuryIds = Object.values(ACCOUNTS).map(a => a.treasury_id);

    // Agents
    const agents = await query(
      `SELECT id, name, address, user_id, battle_limit_usdc
       FROM ${S}.agents WHERE user_id = ANY($1) ORDER BY user_id, id`, [userIds]
    );
    const agentAddresses = agents.map(a => a.address);

    // Deposits & withdrawals from arena_op_ledger
    const ledger = await query(
      `SELECT treasury_id, kind, sum(amount) as total
       FROM ${S}.arena_op_ledger WHERE treasury_id = ANY($1)
       GROUP BY treasury_id, kind`, [treasuryIds]
    );

    // Per-agent PNL totals
    const agentPnl = await query(`
      SELECT agent_address, agent_name,
        sum(pnl_wei) as total_pnl,
        sum(usdc_share_wei) as total_share,
        count(*) as battles,
        count(*) FILTER (WHERE pnl_wei > 0) as wins,
        count(*) FILTER (WHERE pnl_wei < 0) as losses
      FROM ${S}.arena_battle_results
      WHERE agent_address = ANY($1)
      GROUP BY agent_address, agent_name
    `, [agentAddresses]);

    // Build response
    const result = {};
    for (const [name, info] of Object.entries(ACCOUNTS)) {
      const deposits = ledger.filter(l => String(l.treasury_id) === String(info.treasury_id) && l.kind === 'deposit')
        .reduce((s, l) => s + parseInt(l.total), 0);
      const withdrawals = ledger.filter(l => String(l.treasury_id) === String(info.treasury_id) && l.kind === 'withdraw')
        .reduce((s, l) => s + parseInt(l.total), 0);

      const acctAgents = agents.filter(a => String(a.user_id) === String(info.user_id));
      const acctAddrs = acctAgents.map(a => a.address);
      const acctPnl = agentPnl.filter(p => acctAddrs.includes(p.agent_address));

      const totalPnl = acctPnl.reduce((s, p) => s + parseInt(p.total_pnl), 0);
      const totalShare = acctPnl.reduce((s, p) => s + parseInt(p.total_share || 0), 0);
      const startBalance = deposits - withdrawals;
      const currentBalance = startBalance + totalPnl;

      result[name] = {
        wallet: info.wallet,
        start_balance: startBalance,
        current_balance: currentBalance,
        total_pnl: totalPnl,
        total_share: totalShare,
        agents: acctPnl,
      };
    }

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Dashboard running at http://localhost:${PORT}`));
