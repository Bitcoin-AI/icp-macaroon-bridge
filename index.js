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


// Universal handler to forward requests to LND API
// Universal handler to forward requests to LND API
app.use('/', (req, res) => {
  const url = 'https://lnd1.regtest.getalby.com' + req.url;
  console.log('Forwarding request to:', url);  // Log the URL

  const headers = {
    ...req.headers,
    'Grpc-Metadata-macaroon': 'a170a08696e766f69636573120472656164120577726974651a210a086d616361726f6f6e120867656e6572617465120472656164120577726974651a160a076d657373616765120472656164120577726974651a170a086f6666636861696e120472656164120577726974651a160a076f6e636861696e120472656164120577726974651a140a057065657273120472656164120577726974651a180a067369676e6572120867656e657261746512047265616400000620a3f810170ad9340a63074b6dded31ed83a7140fd26c7758856111583b7725b2b',
  };
  delete headers['x-forwarded-for'];
  delete headers['x-forwarded-proto'];
  delete headers['forwarded'];


  const options = {
    url,
    rejectUnauthorized: false,
    json: true,
    headers: headers,
    body: req.body,
    method: req.method,
  };

  console.log('Request options:', options);  // Log the request options

  request(options, (error, response, body) => {
    if (error) {
      console.error('Error:', error);
      return res.status(500).json({ error: 'Failed to forward the request' });
    }

    console.log('Response received:', body);  // Log the response

    res.json(body);
  });
});




// Post to pay invoice to user, verify conditions firts (must come from canister)



app.listen(process.env.PORT ? process.env.PORT : 8080, () => {
  console.log(`Service initiated at port ${process.env.PORT ? process.env.PORT : 8080}`)
});
