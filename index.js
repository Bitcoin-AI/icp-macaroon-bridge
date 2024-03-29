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


import { Firestore } from '@google-cloud/firestore';

const { v4: uuidv4 } = require('uuid');


import dotenv from 'dotenv';



dotenv.config({ path: './.env' });

const app = express();

const firestoreCredentials = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
};

const db = new Firestore({
  projectId: firestoreCredentials.projectId,
  credentials: {
    client_email: firestoreCredentials.clientEmail,
    private_key: firestoreCredentials.privateKey,
  },
});





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

const ongoingRequests = new Map();

app.use(async (req, res, next) => {
  try {
    const requestId = uuidv4(); // Generate a unique identifier for the request+
    console.log(`Request ID: ${requestId} - Received request from IP: ${req.ip}, Path: ${req.path}, Method: ${req.method}`);


    const idempotencyKey = req.headers['idempotency-key'];
    console.log(`Request ID: ${requestId} - Idempotency Key:`, idempotencyKey);

    if (idempotencyKey) {
      const doc = await db.collection('test').doc(idempotencyKey).get();

      if (doc.exists) {
        console.log('Request already processed, returning stored response');
        return res.json(doc.data().responseData); // Return the stored response
      } else if (ongoingRequests.has(idempotencyKey)) {
        console.log(`Request ID: ${requestId} -- Duplicate request detected, waiting for a bit before re-checking Firestore`);

        setTimeout(async () => {
          const docAfterWait = await db.collection('test').doc(idempotencyKey).get();
          if (docAfterWait.exists) {
            console.log('Found stored response after waiting');
            return res.json(docAfterWait.data().responseData);
          } else {
            console.log(`Request ID: ${requestId} -- No stored response found after waiting, proceeding to handle request`);
            // You might want to handle this case depending on your application's needs
          }
        }, 2000);  // Wait for 500ms before re-checking

        return; // Exit the current execution to wait
      } else {
        const ongoingRequest = new Promise((resolve, reject) => {
          req.on('end', resolve);
          req.on('error', reject);
        });
        ongoingRequests.set(idempotencyKey, ongoingRequest);
      }

      const { json: originalJson } = res;
      res.json = function (body) {
        originalJson.call(this, body);


        console.log(`Response body for: ${requestId} `, body);

        // if (res.statusCode === 200) {
        const data = {
          idempotencyKey,
          responseData: body,
        };

        db.collection('test')
          .doc(idempotencyKey)
          .set(data)
          .then(() => {
            console.log(`Request ID: ${requestId} -- Data stored in Firestore `);
            ongoingRequests.delete(idempotencyKey);
          })
          .catch((error) => console.error('Error storing data in Firestore:', error));
        // }
      };
    }

    next();
  } catch (error) {
    console.error('Error in middleware:', error);
    res.status(500).json({ error: 'An error occurred while processing the request' });
  }
});




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
      if (error) {
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

app.post('/v1/invoices', (req, res) => {


  const { value: amount, memo: evm_addr } = req.body;  // Updated this line

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
    res.json(body);
  });
});


app.get('/v2/invoices/lookup', async (req, res) => {
  try {
    const payment_hash = req.query.payment_hash;

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
app.post('/payInvoice', async (req, res) => {
  try {

    const sk = process.env.NOSTR_SK;
    const pk = getPublicKey(sk);

    // Verify if request comes from icp canister

    const signatureBase = "0x" + req.headers.signature;
    let message = req.body.payment_request;
    const messageHash = ethers.utils.keccak256(Buffer.from(message));

    message = message.substring(message.indexOf("lntb"), message.length);
    console.log(`Preparing to check ${message}`)
    // Define a list of expected addresses
    const expectedAddresses = [
      '0x492d553f456231c67dcd4a0f3603b3b1f2918a95'.toLowerCase(),
      '0xc5acf85fedb04cc84789e5d84c0dfcb74388c157'.toLowerCase(),
      '0xeafdc02a5341a7b2542056a85b77a8db09a71fe9'.toLowerCase(),
      '0xf86f2aa698732a9b00511b61f348981076e447b8'.toLowerCase(),
      '0x3cca770bbe348cfc53e3b6348c18363a14cf1d38'.toLowerCase(),
      '0xc58b5996da0dfc22c821adf8eefd3bf0da767f6d'.toLowerCase(),
      '0x406987a57d923f34e4f4618c3337dd5f51faf06f'.toLowerCase()


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

      console.error("invalid signature");

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
    console.log(`Checking if invoice was already published in nostr`)
    if (previousEvent) {
      console.error("Invoice already paid");

      res.json({
        message: "Invoice already paid"
      });
      return;
    }

    // Pay Invoice and store hash of signature at nostr
    console.log(`Paying invoice`)
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
        console.log(error)
        res.json(error);
        return;
      }
      console.log(`Invoice paid`)

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
      console.log(`Publishing in nostr`)

      let pubs = pool.publish(relays, event);
      console.log(`Done`)

      res.json(body);
      return;
    });



  } catch (err) {
    console.log("ERROR:", err);
    res.json(err)
  }
  return;
});


app.post('/payBlockchainTx', (req, res) => {
  try {
    const sendTxPayload = req.body;
    const idempotencyKey = req.headers['idempotency-key'];

    console.log('Idempotency Key:', idempotencyKey);
    console.log('Sending tx:', JSON.stringify(sendTxPayload));


    const rskNodeUrl = 'https://rsk.getblock.io/437f13d7-2175-4d2c-a8c4-5e45ef6f7162/testnet/';
    const options = {
      url: rskNodeUrl,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(sendTxPayload)
    };

    request.post(options, (error, response, body) => {
      if (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'An error occurred while processing the transaction' });
        return;
      }

      console.log('Transaction processed, returning response to client');
      res.json(JSON.parse(body));
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'An error occurred while processing the transaction' });
  }
});



app.post('/payBlockchainTx', (req, res) => {
  try {
    const sendTxPayload = req.body;
    const idempotencyKey = req.headers['idempotency-key'];

    console.log('Idempotency Key:', idempotencyKey);
    console.log('Sending tx:', JSON.stringify(sendTxPayload));


    const rskNodeUrl = 'https://rsk.getblock.io/437f13d7-2175-4d2c-a8c4-5e45ef6f7162/testnet/';
    const options = {
      url: rskNodeUrl,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(sendTxPayload)
    };

    request.post(options, (error, response, body) => {
      if (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'An error occurred while processing the transaction' });
        return;
      }

      console.log('Transaction processed, returning response to client');
      res.json(JSON.parse(body));
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'An error occurred while processing the transaction' });
  }
});



app.post('/getEvents', (req, res) => {
  try {
    const sendTxPayload = req.body;
    const idempotencyKey = req.headers['idempotency-key'];

    console.log('Idempotency Key:', idempotencyKey);
    console.log('Sending tx:', JSON.stringify(sendTxPayload));


    const rskNodeUrl = 'https://rsk.getblock.io/437f13d7-2175-4d2c-a8c4-5e45ef6f7162/testnet/';
    const options = {
      url: rskNodeUrl,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(sendTxPayload)
    };

    request.post(options, (error, response, body) => {
      if (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'An error occurred while processing the transaction' });
        return;
      }

      console.log('Transaction processed, returning response to client');
      res.json(JSON.parse(body));
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'An error occurred while processing the transaction' });
  }
});



app.post('/interactWithNode', (req, res) => {
  try {
    const sendTxPayload = req.body;
    const idempotencyKey = req.headers['idempotency-key'];

    console.log('Idempotency Key:', idempotencyKey);
    console.log('Sending tx:', JSON.stringify(sendTxPayload));


    const rskNodeUrl = 'https://rsk.getblock.io/437f13d7-2175-4d2c-a8c4-5e45ef6f7162/testnet/';
    const options = {
      url: rskNodeUrl,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(sendTxPayload)
    };

    request.post(options, (error, response, body) => {
      if (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'An error occurred while processing the transaction' });
        return;
      }

      console.log('Transaction processed, returning response to client');
      res.json(JSON.parse(body));
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'An error occurred while processing the transaction' });
  }
});

app.listen(process.env.PORT ? process.env.PORT : 8080, () => {
  console.log(`Service initiated at port ${process.env.PORT ? process.env.PORT : 8080}`)
});
