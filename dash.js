#!/usr/bin/env node
'use strict'
const fetch = require("node-fetch");
const dotenv = require("dotenv");
const { Command } = require("commander");
dotenv.config();
const fs = require('fs').promises;

const HR_BASE_URL = 'https://api.freee.co.jp/hr/api/v1/';
const REFRESH_TOKEN_URL = 'https://accounts.secure.freee.co.jp/public_api/token';
const freee_token = process.env.freee_token;
const refresh_token = process.env.refresh_token;
const webhook_url = process.env.webhook_url;
const username = process.env.username;
const icon_url = process.env.icon_url;
const channel = process.env.channel;
const slack_token = process.env.slack_token;
const slack_change_status_url = process.env.slack_change_status_url;

const clocks = {
  in: {
    type: 'clock_in',
    text: "出勤",
    typo: "出勤"
  },
  begin: {
    type: 'break_begin',
    text: 'QK',
    typo: 'QK'
  },
  end: {
    type: 'break_end',
    text: 'もどり',
    typo: 'modori'
  },
  out: {
    type: 'clock_out',
    text: '退勤',
    typo: 'ちきん'
  }
};
const program = new Command();
program.version('1.0.0');

program
  .arguments('<status>')
  .option("-m, --message <honorific>", "override slack message")
  .usage(`
  in: punch in freee
  out: punch out freee
  begin: begin break time
  end: end break time`
  )
  .action(async (param, options) => await punchHandler(param, options));
program.parse();

async function punchHandler(command, options) {
  try {
    console.time("log");
    if (command === "log") {
      // ログ出力
      await log();
    } else if (command === "log-all") {
      await logAll();
    } else {
      // 打刻
      await punch(command, options.message);
    }
    console.timeEnd("log");
    if (command !== "log" && command !== "log-all") {
      console.log(`successly get logs. : ${new Date()}`)
    } else {
      console.log(`ok, now punch ${command} : ${new Date()}`)
    }
  } catch (e) {
    console.error(e);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}
  
async function punch(status, message) {
  const tokens = await udpateToken();
  const userInfo = await getUserId(tokens.freee_token);
  const userId = userInfo.companies[0].employee_id;
  const companyId = userInfo.companies[0].id;
  const abailable = await getabailable(tokens.freee_token, userId, companyId);
  if (Object.keys(clocks).includes(status)) {
    if (!abailable.available_types.includes(clocks[status].type)) {
      throw new Error(`not abailable: ${abailable.available_types}`);
    }
    await changeStatus(tokens.freee_token, userId, companyId, clocks[status].type);
  }
  // const sendMessageBody = message ? message : Math.random() < 0.93 ? clocks[status].text : clocks[status].typo
  // await sendMessage(sendMessageBody);
  await changeSlackStatus(status, message);
};

async function log() {
  const tokens = await udpateToken();
  const userInfo = await getUserId(tokens.freee_token);
  const userId = userInfo.companies[0].employee_id;
  const companyId = userInfo.companies[0].id;
  const options = {
    method: 'GET',
    headers: createAuthHeader(tokens.freee_token)
  };
  const today = new Date();
  if (today.getHours() < 5) {
    if (today.getDate() === 1) {
      const month = today.getMonth();
      const year = today.getFullYear();
      if (month === 0) {
        today.setFullYear(year - 1);
        today.setMonth(11);
        today.setDate(getDaysInMonth(12));
      } else {
        today.setMonth(month-1);
        today.setDate(getDaysInMonth(month));
      }
    } else {
      today.setDate(today.getDate() - 1)
    }
  }
  const parsedDate = `${today.getFullYear()}-${`00${today.getMonth() + 1}`.slice(-2)}-${`00${today.getDate()}`.slice(-2)}`
  const result = await (await fetch(`${HR_BASE_URL}/employees/${userId}/work_records/${parsedDate}?company_id=${companyId}`, options)).json();
  await fs.writeFile('punchLogs.json',
    // Object.keys(updated).map(v => `${v}=${updated[v]}`).join('\n')
    JSON.stringify(result)
  )
  return result
}
async function logAll() {
  const tokens = await udpateToken();
  const userInfo = await getUserId(tokens.freee_token);
  const userId = userInfo.companies[0].employee_id;
  const companyId = userInfo.companies[0].id;
  const options = {
    method: 'GET',
    headers: createAuthHeader(tokens.freee_token)
  };
  const today = new Date().getHours() < 5 ? new Date(new Date().getTime() - 86400000) : new Date();
  const result = await (await fetch(`${HR_BASE_URL}/employees/${userId}/work_record_summaries/${today.getMonth() > 11 ? today.getFullYear() + 1 : today.getFullYear()}/${(today.getMonth()+1) % 12 + 1}?company_id=${companyId}&work_records=true`, options)).json();
  const records = result.work_records;
  const breakRecordsMaxCount = records.reduce((prev, current) => {
    return Math.max(prev, current.break_records.length)
  }, 0);

  const header = parseRecordHeaderToCSV(records[0], breakRecordsMaxCount);
  const lines = [header.join(",")];
  for (const record of records) {
    lines.push(parseSingleRecordToCSV(record, header))
  }
  const summary = records.reduce((prev, current) => {
    const required_minutes_in_day = current.day_pattern === 'normal_day' ? 480 : 0;
    const worked_minute_in_day = current.break_records.reduce((prev2, current2) => {
      return prev2 - (new Date(current2.clock_out_at) - new Date(current2.clock_in_at)) / 60000;
    }, (new Date(current.clock_out_at) - new Date(current.clock_in_at)) / 60000) + current.paid_holiday * 480;
    const left_required_minutes_in_day = required_minutes_in_day - worked_minute_in_day;
    return {
      required_minutes: prev.required_minutes + required_minutes_in_day,
      worked_minutes: prev.worked_minutes + worked_minute_in_day,
      left_required_minutes: prev.left_required_minutes + left_required_minutes_in_day
    }
  }, {
    required_minutes: 0,
    worked_minutes: 0,
    left_required_minutes: 0
  });

  console.log(`
    ======現在の労働時間情報======
    必要稼働時間 : ${`000${Math.floor(summary.required_minutes / 60)}`.slice(-3)}:${`00${summary.required_minutes % 60}`.slice(-2)}
    稼働済み時間 : ${`000${Math.floor(summary.worked_minutes / 60)}`.slice(-3)}:${`00${summary.worked_minutes % 60}`.slice(-2)}
    残り稼働時間 : ${`000${Math.floor(summary.left_required_minutes / 60)}`.slice(-3)}:${`00${summary.left_required_minutes % 60}`.slice(-2)}
  `)
  
  await fs.writeFile('punchMonthlyLogs.csv',
    lines.join("\n")
  )
  return records;
}
function parseRecordHeaderToCSV (record, breakRecordsMaxCount) {
  const brHeader = [];
  for (let i=0; i< breakRecordsMaxCount; i++) {
    brHeader.push(`break_records[${i}].clock_in_at`);
    brHeader.push(`break_records[${i}].clock_out_at`);
  }
  return brHeader.concat(Object.keys(record).filter(str => str !== "break_records")).concat([
    
  ])
}
function parseSingleRecordToCSV (record, header) {
  return header.map(head => {
    if (head.indexOf('.') > 0) {
      const found = head.match(/break_records\[(\d+)\]\.(clock_in_at|clock_out_at)/);
      const break_record = record.break_records[found[1]]
      return break_record ? break_record[found[2]] : "";
    } else {
      return record[head];
    }
  }).join(",")
}
function isLeapYear(year) {
  if (year % 400 === 0) {
    return true;
  }
  if (year % 100 === 0) {
    return false;
  }
  if (year % 4 === 0) {
    return true;
  }
  return false;
}
function getDaysInMonth(month, year) {
  const isLeapYear = isLeapYear(year);
  switch(month) {
    case 2:
      return isLeapYear ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

async function udpateToken() {
  const headers = { "Authorization": ` Bearer ${freee_token}`, "Content-Type": "application/json" };
  const client_id = process.env.client_id;
  const client_secret = process.env.client_secret;
  const raw = JSON.stringify({
    grant_type: "refresh_token",
    client_id,
    client_secret,
    refresh_token,
  });

  const options = {
    method: "POST",
    headers,
    body: raw
  }
  const result = await (await fetch(REFRESH_TOKEN_URL, options)).json();
  const updated = {
    freee_token: result.access_token,
    refresh_token: result.refresh_token,
    client_id,
    client_secret,
    channel,
    webhook_url,
    slack_change_status_url,
    username,
    icon_url,
    slack_token
  };

  await fs.writeFile('.env',
    Object.keys(updated).map(v => `${v}=${updated[v]}`).join('\n')
  )
  return updated;
}

async function getUserId(token) {
  const options = defaultGETOption(token)
  const result = await (await fetch(HR_BASE_URL + '/users/me', options)).json();
  // console.log(result);
  return result;
}

async function getabailable(token, userId, companyId) {
  const options = defaultGETOption(token)
  const result = await (await fetch(`${HR_BASE_URL}/employees/${userId}/time_clocks/available_types?company_id=${companyId}`, options)).json();
  // console.log(result);
  return result;
}

async function changeStatus(token, userId, company_id, status) {
  const options = {
    method: 'POST',
    headers: createAuthHeader(token),
    body: JSON.stringify({
      company_id,
      type: status,
      base_date: timestampToTime(new Date())
    })
  };
  const result = await (await fetch(`${HR_BASE_URL}/employees/${userId}/time_clocks`, options)).json();
  // console.log(result);
  return result;
}

function timestampToTime(date) {
  const yyyy = `${date.getFullYear()}`;
  const MM = `0${date.getMonth() + 1}`.slice(-2);
  const dd = `0${date.getDate()}`.slice(-2);

  return `${yyyy}-${MM}-${dd}`;
}

async function sendMessage(text) {
  console.log(JSON.stringify({
    text,
    channel,
    username,
    slack_token
  }))
  const options = {
    method: 'POST',
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Authorization": ` Bearer ${slack_token}`
    },
    body: JSON.stringify({
      text,
      channel,
      as_user: username
    })
  };
  // NOTE: ここは「ok」しか返ってこない
  const result = await (await fetch(`${webhook_url}`, options)).text();
  console.log(result);
}

async function changeSlackStatus(status, message) {
  const status_obj = (() => {
    switch(status) {
      case 'in':
      case 'end':
        return {
          profile: {
            status_text: message || 'リモート勤務中',
            status_emoji: ':kin_grad:',
            status_expiration: 0
          }
        }
      case 'out':
        return {
          profile: {
            status_text: message || '本日の勤務は終了しました',
            status_emoji: ':end_grad:',
            status_expiration: 0
          }
        }
      case 'begin':
        return {
          profile: {
            status_text: message || '休憩中',
            status_emoji: ':kei_grad:',
            status_expiration: 0
          }
        }
      case 'con':
        return {
          profile: {
            status_text: message || '集中モード',
            status_emoji: ':shuchu:',
            status_expiration: 0
          }
        }
    }
  })()
  console.log(status_obj)
  const options = {
    method: 'POST',
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Authorization": ` Bearer ${slack_token}`
    },
    body: JSON.stringify(status_obj)
  };
  // NOTE: ここは「ok」しか返ってこない
  const result = await (await fetch(`${slack_change_status_url}`, options)).text();
  // console.log(result);
}

function createAuthHeader(token) {
  return {
    "Authorization": ` Bearer ${token}`,
    "Content-Type": "application/json; charset=UTF-8"
  };
}

function defaultGETOption(token){
  return {
    method: 'GET',
    headers: {
      "Authorization": ` Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8"
    }
  };
}
