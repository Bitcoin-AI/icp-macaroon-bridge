const express = require('express');
const request = require('request');
const ethers = require('ethers');
const dotenv = require('dotenv');

dotenv.config();
const app = express();

app.use(express.json()); // Added to parse JSON bodies

// Test Route
app.get('/', (req, res) => {
    let options = {
        url: `https://${process.env.REST_HOST}/v1/getinfo`,
        rejectUnauthorized: false,
        json: true,
        headers: {
            'Grpc-Metadata-macaroon': process.env.MACAROON_HEX,
        },
    };
    request.get(options, function (error, response, body) {
        res.json(body);
    });
});

// Post to pay invoice to user, verify conditions first (must come from canister)
app.post('/', (req, res) => {
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

    // ... (rest of your code)


    let options = {
        url: `https://${process.env.REST_HOST}/v2/router/send`,
        rejectUnauthorized: false,
        json: true,
        headers: {
            'Grpc-Metadata-macaroon': process.env.MACAROON_HEX,
        },
        body: JSON.stringify(
            {
                payment_request: req.body.payment_request
            }
        ),
    };
    request.post(options, function (error, response, body) {
        res.json(body);
    });
});

app.listen(8080, () => {
    console.log("Service initiated at port 8080"); // Corrected the port number in the log message
});
