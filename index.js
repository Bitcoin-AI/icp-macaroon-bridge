import express from 'express';
import request from 'request';
import { ethers } from 'ethers'
import { Buffer } from 'buffer';
import {
  SimplePool,
  nip19,
  generatePrivateKey,
  getPublicKey,
  getEventHash,
  getSignature
} from 'nostr-tools'
import 'websocket-polyfill'



import dotenv from 'dotenv';

import { v4 as uuidv4 } from 'uuid';


dotenv.config({ path: './.env' });
const app = express();

app.use(express.json());


const relays = JSON.parse(process.env.RELAYS);
const interval = JSON.parse(process.env.INTERVAL);

const pool = new SimplePool()

const delay = ms => new Promise(res => setTimeout(res, ms));

function getRandomInt(min, max) {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min) + min); // The maximum is exclusive and the minimum is inclusive
}

const storeIdempotencyKey = async (messageHash,body) => {
  console.log(`Storing with idempotencyKey: ${messageHash}`);
  const sk = process.env.NOSTR_SK;

  const pk = getPublicKey(sk);
  const npub = nip19.npubEncode(pk)
  console.log(`Using npub: ${npub} to store event kind 1 with 'd' as 'icp-canister-bridge-test' and 't' as ${messageHash}`)
  let event = {
    kind: 1,
    pubkey: pk,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', 'icp-canister-bridge-test'],
      ['t',messageHash]
    ],
    content: JSON.stringify(body)
  }

  event.id = getEventHash(event);
  event.sig = getSignature(event, sk);
  console.log(`Publishing event ...`);
  let pubs = pool.publish(relays, event);
  await Promise.all(pubs)
  console.log(`Event published`);
  return
}

const getIdempotencyStore = async (idempotencyKey,requestId) => {

  const sk = process.env.NOSTR_SK;
  const pk = getPublicKey(sk);
  const npub = nip19.npubEncode(pk)
  console.log(`Service using npub: ${npub}`);
  const cond = true;
  //("Error: Canister http responses were different across replicas, and no consensus was reached");
  let idempotencyStore;
  let i = 0;
  while(cond){
    console.log(`[${requestId}] Tring to get idempotency key, try ${i} ...`)
    idempotencyStore = await pool.get(relays,
        {
          kinds: [1],
          authors: [pk],
          '#t': [idempotencyKey]
        }
    );
    if(idempotencyStore){
      cond = false;
      console.log(`[${requestId}] Data found`);
    }
    i = i + 1;
    if(i == process.env.MAX_RETRY){
      cond = false;
      console.log(`[${requestId}] Max Retries reached`);
    }
    const time = getRandomInt(interval[0],interval[1]);
    console.log(`[${requestId}] Delaying ${time} ...`)
    await delay(time);
  }

  return(idempotencyStore);
};
// Here to  store the response according to the indempotencyKey
const checkIdempotencyKey = async (req,res,next) => {
  const requestId = uuidv4(); // Generate a unique request ID

  const idempotencyKey = req.headers['idempotency-key'];
  console.log(`[${requestId}] Checking idempotency key: ${idempotencyKey}`);
  if (idempotencyKey) {
    const delayTimeMS = getRandomInt(interval[0],interval[1]);
    console.log(`[${requestId}] Waiting ${delayTimeMS} ms to get value`);
    await delay(delayTimeMS);

    const idempotencyStore = await getIdempotencyStore(idempotencyKey, requestId);
    if (idempotencyStore) {
      console.log(`[${requestId}] Idempotency store found:`, idempotencyStore);
      return res.json(idempotencyStore);
    } else {
      console.log(`[${requestId}] Idempotency value with key ${idempotencyKey} not found, proceeding`);
      next();
    }
  } else {
    console.log(`[${requestId}] No idempotency key at header`);
    return res.json({ message: "No idempotency key at header" });
  }
}

app.use(checkIdempotencyKey);


// Test Route
app.get('/', (req, res) => {
  try {
    let options = {
      url: `https://${process.env.REST_HOST}/v1/getinfo`,
      // Work-around for self-signed certificates.
      rejectUnauthorized: false,
      json: true,
      headers: {
        'Grpc-Metadata-macaroon': process.env.MACAROON_HEX,
      },
    }
    request.get(options, function (error, response, body) {
      res.json(body)
    });
  } catch (err) {
    res.json(err)
  }
  return;
});

app.get('/v1/payreq', async (req, res) => {
  try {
    // Verify if request comes from icp canister
    const idempotencyKey = req.headers['idempotency-key'];
    //const signatureBase = "0x" + req.headers.signature;
    const payment_request = req.params.payment_request;

    let options = {
      url: `https://${process.env.REST_HOST}/v1/payreq/${payment_request}`,
      // Work-around for self-signed certificates.
      rejectUnauthorized: false,
      json: true,
      headers: {
        'Grpc-Metadata-macaroon': process.env.MACAROON_HEX,
      }
    }

    request.get(options, async function (error, response, body) {
      console.log(body)
      if (error) {
        res.json(error);
        return;
      }
      await storeIdempotencyKey(idempotencyKey,body);
      res.json(body);
      return;
    });



  } catch (err) {
    console.log("ERROR:", err);
    res.status(500).json(err)
  }
  return;
});

app.post('/v1/invoices', (req, res) => {
  try{
    const idempotencyKey = req.headers['idempotency-key'];
    const { value: amount, memo: evm_addr } = req.body;  // Updated this line
    console.log(`Preparing to create invoice with memo ${evm_addr} and value ${amount}`);

    // Validate that amount and evm_addr are defined
    if (!amount || !evm_addr) {
      res.status(400).json({ error: 'Both amount and evm_addr are required' });
      return;
    }

    // Validate the type of amount
    if (typeof amount !== 'number' && typeof amount !== 'string') {
      res.status(400).json({ error: 'Invalid type for amount' });
      return;
    }
    console.log(`Body check ok, doing lightning request ...`);

    const options = {
      url: `https://${process.env.REST_HOST}/v1/invoices`,
      rejectUnauthorized: false,
      json: true,
      headers: {
        'Grpc-Metadata-macaroon': process.env.MACAROON_HEX,
      },
      body: {
        value: amount.toString(),
        memo: evm_addr,
      }
    };

    request.post(options, (error, response, body) => {
      if (error) {
        res.status(500).json(error);
        return;
      }
      console.log(`Lightning response sucessfull, storing result ...`);
      storeIdempotencyKey(idempotencyKey,body).then(() => {
        res.json(body);
      })
      .catch(err => {
        console.log(err)
      });
    });
  } catch(err){
    console.log(err);
  }
});


app.get('/v2/invoices/lookup', async (req, res) => {
  try {
    const payment_hash = req.query.payment_hash;
    const idempotencyKey = req.headers['idempotency-key'];

    if (!payment_hash) {
      res.status(400).send({ "error": "payment_hash is required" });
      return;
    }

    let options = {
      url: `https://${process.env.REST_HOST}/v2/invoices/lookup?payment_hash=${payment_hash}`,
      // Work-around for self-signed certificates.
      rejectUnauthorized: false,
      json: true,
      headers: {
        'Grpc-Metadata-macaroon': process.env.MACAROON_HEX,
      }
    }

    request.get(options, async function (error, response, body) {
      console.log(body)
      if (error) {
        res.status(500).json(error);
        return;
      }
      await storeIdempotencyKey(idempotencyKey,body);
      res.json(body);
      return;
    });
  } catch (err) {
    console.log("ERROR:", err);
    res.status(500).json(err);
  }
  return;
});


app.get('/v1/getinfo', (req, res) => {
  const options = {
    url: `https://${process.env.REST_HOST}/v1/getinfo`,
    rejectUnauthorized: false,
    json: true,
    headers: {
      'Grpc-Metadata-macaroon': process.env.MACAROON_HEX,
    },
  };

  request.get(options, (error, response, body) => {
    if (error) {
      res.status(500).json(error);
      return;
    }
    res.json(body);
  });
});


// Post to pay invoice to user, verify conditions firts (must come from canister)
app.post('/', async (req, res) => {
  try {
    const idempotencyKey = req.headers['idempotency-key'];

    const sk = process.env.NOSTR_SK;
    const pk = getPublicKey(sk);

    // Verify if request comes from icp canister

    const signatureBase = "0x" + req.headers.signature;
    const message = req.body.payment_request;

    const messageHash = ethers.utils.keccak256(Buffer.from(message));

    // Define a list of expected addresses
    const expectedAddresses = [
      '0x492d553f456231c67dcd4a0f3603b3b1f2918a95'.toLowerCase(),
      '0xc5acf85fedb04cc84789e5d84c0dfcb74388c157'.toLowerCase(),
      '0xeafdc02a5341a7b2542056a85b77a8db09a71fe9'.toLowerCase()
      // ... add more addresses as needed
    ];

    // Try both possible v values for chain ID 31
    const vValues = ['59', '5a'];
    let isValidSignature = false;
    let recoveredAddress;

    vValues.forEach(v => {
      try {
        const fullSignature = signatureBase + v;
        recoveredAddress = ethers.utils.recoverAddress(messageHash, ethers.utils.splitSignature(fullSignature));
        console.log("address: ", recoveredAddress.toLowerCase());

        if (expectedAddresses.includes(recoveredAddress.toLowerCase())) {
          isValidSignature = true;
        }
      } catch (error) {
        console.error(`Error recovering address with v = 0x${v}:`, error);
      }
    });

    if (!isValidSignature) {
      res.json({
        message: "Invalid signature"
      });
      return;
    }


    const previousEvent = await pool.get(relays,
      {
        kinds: [1],
        authors: [pk],
        '#t': [messageHash]
      }
    );
    console.log(previousEvent)
    if (previousEvent) {
      res.json({
        message: "Invoice already paid"
      });
      return;
    }

    // Pay Invoice and store hash of signature at nostr

    let options = {
      url: `https://${process.env.REST_HOST}/v2/router/send`,
      // Work-around for self-signed certificates.
      rejectUnauthorized: false,
      json: true,
      headers: {
        'Grpc-Metadata-macaroon': process.env.MACAROON_HEX,
      },
      body: {
        payment_request: message,
        timeout_seconds: 300,
        fee_limit_sat: 100
      }
    }

    request.post(options, async function (error, response, body) {
      if (error) {
        res.json(error);
        return;
      }
      console.log(body)

      let event = {
        kind: 1,
        pubkey: pk,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['t', messageHash]
        ],
        content: `Paid ${message}`
      }

      event.id = getEventHash(event);
      event.sig = getSignature(event, sk);
      let pubs = pool.publish(relays, event);
      await Promise.all(pubs)
      await storeIdempotencyKey(idempotencyKey,body);
      pool.close();
      res.json(body);
      return;
    });



  } catch (err) {
    console.log("ERROR:", err);
    res.json(err)
  }
  return;
});


app.listen(process.env.PORT ? process.env.PORT : 8080, () => {
  console.log(`Service initiated at port ${process.env.PORT ? process.env.PORT : 8080}`)
});
