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
    const signature = req.header?.signature;
    const message = req.body?.payment_request;
    if(!signature || !message){
      res.send("Signature and message required");
      return;
    }
    const address = ethers.utils.verifyMessage( message , signature );

    if(address.toLowerCase() != process.env.CANISTER_ADDRESS.toLowerCase()){
      res.send("Invalid signature");
      return;
    }

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


app.listen(8085,() => {
  console.log("Service initiated at port 8085")
});
