import express from "express";
import cors from "cors";
import session from "express-session";
import * as openvidu from "openvidu-node-client";
import fs from "fs";
import https from "https";

export const app = express();

// const OPENVIDU_URL = "https://192.168.7.56" // process.env.OPENVIDU_URL || process.argv[2] || 'http://localhost:4443';
const OPENVIDU_URL = "http://localhost:4443" // process.env.OPENVIDU_URL || process.argv[2] || 'http://localhost:4443';
// Environment constiable: secret shared with our OpenVidu server
const OPENVIDU_SECRET = 'MY_SECRET' // process.env.OPENVIDU_SECRET || process.argv[3] || 'MY_SECRET';

// Entrypoint to OpenVidu Node Client SDK
const ov = new openvidu.OpenVidu(OPENVIDU_URL, OPENVIDU_SECRET);

// Collection to pair session names with OpenVidu Session objects
const mapSessions = {};
// Collection to pair session names with tokens
const mapSessionNamesTokens = {};

// Listen (start app with node server.js)


// Mock database
const users = [{
    user: "publisher1",
    pass: "pass",
    role: openvidu.OpenViduRole.PUBLISHER
}, {
    user: "publisher2",
    pass: "pass",
    role: openvidu.OpenViduRole.PUBLISHER
}, {
    user: "subscriber",
    pass: "pass",
    role: openvidu.OpenViduRole.SUBSCRIBER
}];

export async function createServer() {
    // init db
    const port = 8080;

    // enabling cors for all requests by using cors middleware
    app.use(cors());

    // parse requests of content-type: application/json
    // parses incoming requests with JSON payloads
    app.use(express.json());
    // parse requests of application/x-www-form-urlencoded
    app.use(express.urlencoded({
        extended: true
    }));
    app.use(session({
        saveUninitialized: true,
        resave: false,
        secret: 'MY_SECRET'
    }));
    initWebRtc();
    const options = {
        key: fs.readFileSync('openvidukey.pem'),
        cert: fs.readFileSync('openviducert.pem')
    };
    app.listen(port, () => {
        console.log(`server started at http://localhost:${port}`);
    });
    // https.createServer(options, app).listen(8081);
}

export function initWebRtc() {
    app.post('/api-login/login', function (req, res) {

        // Retrieve params from POST body
        const user = req.body.user;
        const pass = req.body.pass;
        console.log("Logging in | {user, pass}={" + user + ", " + pass + "}");

        if(login(user, pass)) { // Correct user-pass
            // Validate session and return OK
            // Value stored in req.session allows us to identify the user in future requests
            console.log("'" + user + "' has logged in");
            req.session.loggedUser = user;
            res.status(200).send();
        } else { // Wrong user-pass
            // Invalidate session and return error
            console.log("'" + user + "' invalid credentials");
            req.session.destroy();
            res.status(401).send('User/Pass incorrect');
        }
    });

    // Logout
    app.post('/api-login/logout', function (req, res) {
        console.log("'" + req.session.loggedUser + "' has logged out");
        req.session.destroy();
        res.status(200).send();
    });

    // Get token (add new user to session)
    app.post('/api-sessions/get-token', function (req, res) {
        if(!isLogged(req.session)) {
            req.session.destroy();
            res.status(401).send('User not logged');
        } else {
            // The video-call to connect
            const sessionName = req.body.sessionName;

            // Role associated to this user
            const role = users.find(u => (u.user === req.session.loggedUser)).role;

            // Optional data to be passed to other users when this user connects to the video-call
            // In this case, a JSON with the value we stored in the req.session object on login
            const serverData = JSON.stringify({ serverData: req.session.loggedUser });

            console.log("Getting a token | {sessionName}={" + sessionName + "}");

            // Build connectionProperties object with the serverData and the role
            const connectionProperties = {
                data: serverData,
                role: role
            };

            if(mapSessions[sessionName]) {
                // Session already exists
                console.log('Existing session ' + sessionName);

                // Get the existing Session from the collection
                const mySession = mapSessions[sessionName];

                // Generate a new token asynchronously with the recently created connectionProperties
                mySession.createConnection(connectionProperties)
                    .then(connection => {

                        // Store the new token in the collection of tokens
                        mapSessionNamesTokens[sessionName].push(connection.token);

                        // Return the token to the client
                        res.status(200).send({
                            0: connection.token
                        });
                    })
                    .catch(error => {
                        console.error(error);
                    });
            } else {
                // New session
                console.log('New session ' + sessionName);

                // Create a new OpenVidu Session asynchronously
                ov.createSession()
                    .then(session => {
                        // Store the new Session in the collection of Sessions
                        mapSessions[sessionName] = session;
                        // Store a new empty array in the collection of tokens
                        mapSessionNamesTokens[sessionName] = [];

                        // Generate a new connection asynchronously with the recently created connectionProperties
                        session.createConnection(connectionProperties)
                            .then(connection => {

                                // Store the new token in the collection of tokens
                                mapSessionNamesTokens[sessionName].push(connection.token);

                                // Return the Token to the client
                                res.status(200).send({
                                    0: connection.token
                                });
                            })
                            .catch(error => {
                                console.error(error);
                            });
                    })
                    .catch(error => {
                        console.error(error);
                    });
            }
        }
    });

    // Remove user from session
    app.post('/api-sessions/remove-user', function (req, res) {
        if(!isLogged(req.session)) {
            req.session.destroy();
            res.status(401).send('User not logged');
        } else {
            // Retrieve params from POST body
            const sessionName = req.body.sessionName;
            const token = req.body.token;
            console.log('Removing user | {sessionName, token}={' + sessionName + ', ' + token + '}');

            // If the session exists
            if(mapSessions[sessionName] && mapSessionNamesTokens[sessionName]) {
                const tokens = mapSessionNamesTokens[sessionName];
                const index = tokens.indexOf(token);

                // If the token exists
                if(index !== -1) {
                    // Token removed
                    tokens.splice(index, 1);
                    console.log(sessionName + ': ' + tokens.toString());
                } else {
                    const msg = 'Problems in the app server: the TOKEN wasn\'t valid';
                    console.log(msg);
                    res.status(500).send(msg);
                }
                if(tokens.length == 0) {
                    // Last user left: session must be removed
                    console.log(sessionName + ' empty!');
                    delete mapSessions[sessionName];
                }
                res.status(200).send();
            } else {
                const msg = 'Problems in the app server: the SESSION does not exist';
                console.log(msg);
                res.status(500).send(msg);
            }
        }
    });
}