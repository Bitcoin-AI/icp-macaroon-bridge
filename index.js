import express from 'express';
import request from 'request';
import {ethers} from 'ethers'
import * as dotenv from 'dotenv';
import {Buffer} from 'buffer';
import {
  SimplePool,
  nip19,
  generatePrivateKey,
  getPublicKey,
  getEventHash,
  getSignature
 } from 'nostr-tools'
 import 'websocket-polyfill'

dotenv.config();
const app = express();

const sk = process.env.NOSTR_SK;
const pk = getPublicKey(sk);

const relays = [
  'wss://relay.damus.io',
  'wss://eden.nostr.land',
  'wss://nostr-pub.wellorder.net',
  'wss://relay.nostr.info',
  'wss://relay.snort.social',
  'wss://nostr-01.bolt.observer'
]

const pool = new SimplePool()

// Test Route
app.get('/', (req, res) => {
  try{
    let options = {
      url: `https://${process.env.REST_HOST}/v1/getinfo`,
      // Work-around for self-signed certificates.
      rejectUnauthorized: false,
      json: true,
      headers: {
        'Grpc-Metadata-macaroon': process.env.MACAROON_HEX,
      },
    }
    request.get(options, function(error, response, body) {
      res.json(body)
    });
  } catch(err){
    res.json(err)
  }
  return;
});


// Post to pay invoice to user, verify conditions firts (must come from canister)
app.post('/', async (req, res) => {
  try{
    // Verify if request comes from icp canister
    const signatureBase = "0x" + req.headers.signature;
    const message = req.body.payment_request;

    const messageHash = ethers.utils.keccak256(Buffer.from(message));

    const expectedAddress = process.env.CANISTER_ADDRESS.toLowerCase();

    // Try both possible v values for chain ID 31
    const vValues = ['59', '5a'];
    let isValidSignature = false;
    let recoveredAddress;

    vValues.forEach(v => {
        try {
            const fullSignature = signatureBase + v;
            recoveredAddress = ethers.utils.recoverAddress(messageHash, ethers.utils.splitSignature(fullSignature));
            if (recoveredAddress.toLowerCase() === expectedAddress) {
                isValidSignature = true;
            }
        } catch (error) {
            console.error(`Error recovering address with v = 0x${v}:`, error);
        }
    });

    if (!isValidSignature) {
        console.log("address: ", recoveredAddress.toLowerCase());
        res.send("Invalid signature");
        return;
    }


    // Hash signature and store in nostr to check
    const signHash = ethers.utils.sha256(Buffer.from(signature))
    const previousEvent = await pool.get(relays, {
      kinds: [1],
      authors: [pk],
      tags: [
        ['signature',signHash]
      ]
    });
    console.log(previousEvent)
    if(previousEvent){
      res.send("Invoice already payed");
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
      body: JSON.stringify(
        {
          payment_request: message
        }
      ),
    }

    request.post(options, async function(error, response, body) {
      // Save hashed signature at nostr kind 1 (short text note)
      let event = {
        kind: 1,
        pubkey: pk,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['signature', signHash]
        ],
        content: signHash
      }

      event.id = getEventHash(event);
      event.sig = getSignature(event, sk);
      let pubs = pool.publish(relays, event);
      res.json(body);
      return;
    });

  } catch(err){
    res.json(err)
  }
  return;
});


app.listen(process.env.PORT ? process.env.PORT : 8080,() => {
  console.log(`Service initiated at port ${process.env.PORT ? process.env.PORT : 8080}`)
});
