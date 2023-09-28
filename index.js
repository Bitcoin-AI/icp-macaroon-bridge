import express from 'express';
import request from 'request';
import { ethers } from 'ethers'
import * as dotenv from 'dotenv';
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

dotenv.config({ path: './.env' });
const app = express();

app.use(express.json());



const relays = [
  'wss://relay.damus.io',
  //'wss://eden.nostr.land',
  //'wss://nostr-pub.wellorder.net',
  //'wss://relay.nostr.info',
  //'wss://relay.snort.social',
  //'wss://nostr-01.bolt.observer'
]

const pool = new SimplePool()

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

// Post to pay invoice to user, verify conditions firts (must come from canister)
app.get('/v1/payreq/:payment_request', async (req, res) => {
  try {


    // Verify if request comes from icp canister

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
      if(error){
        res.json(error);
        return;
      }
      res.json(body);
      return;
    });



  } catch (err) {
    console.log("ERROR:", err);
    res.status(500).json(err)
  }
  return;
});


// Post to pay invoice to user, verify conditions firts (must come from canister)
app.post('/', async (req, res) => {
  try {


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
      if(error){
        res.json(error);
        return;
      }
      console.log(body)

      // Save invoice at nostr kind 1 (short text note)

      let event = {
        kind: 1,
        pubkey: pk,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['t',messageHash]
        ],
        content: `Paid ${message}`
      }

      event.id = getEventHash(event);
      event.sig = getSignature(event, sk);
      let pubs = pool.publish(relays, event);

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
