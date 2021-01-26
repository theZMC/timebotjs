require('dotenv').config();
const mysql     = require('mariadb');
const fetch     = require('node-fetch');


// get the clock in statuses from tsheets
const getApiState = async (opt) =>{
    try {
        const response = await fetch(opt.url, {
            method:     opt.method,
            mode:       'cors',
            cache:      'no-cache',
            headers:    opt.headers,
            body:       opt.body,
            json:       opt.json
        });
        // error out if we don't get an http 200-299 response code
        if(!response.ok){
            console.log(await response.text());
            throw new Error("getApiState(): The request failed.");
        }

        // perform some string ops to make our data more malleable
        const data =            await response.json();
        const current_totals =  await data.results.current_totals;
        const supp_data =       await data.supplemental_data.users;
        const toverride =       JSON.parse(process.env.TECH_OVERRIDE);
        
        // initialize our api state array
        let api_state = [];

        // iterate over our response and build out the api state array
        for(const property in await current_totals){
            // create name by combining first and last name
            let uname =     supp_data[property].first_name + ' ' +
                            supp_data[property].last_name;
            // same as above, but with an underscore for channel name.
            let uchannel =  (supp_data[property].first_name + '_' +
                            supp_data[property].last_name).toLowerCase();
            // check for a channel name override for people that hate their names
            uchannel = toverride[uname] ? toverride[uname] : uchannel;
            // push the user info into the api state array
            api_state.push({
                name:           uname,
                channel:        uchannel,
                user_id:        current_totals[property].user_id,
                state:          current_totals[property].on_the_clock,
                jobcode_id:     current_totals[property].jobcode_id
            });
        }
        // return the api state array
        return api_state;
    }
    catch (error) {
        console.error(error);
    }
}

// get clock in states from the local database
const getDbState = async (conn) => {
    conn = await conn;
    let db_state = {};
    try {
        result = await conn.query({
            rowsAsArray: true, 
            sql: "SELECT * FROM state"
        });

        // build a js object so we can use the user id as a key
        result.forEach((row) => {
            db_state[row[0]] = row[1] == "on the clock." ? true : false;
        })
    }
    catch (error){
        console.log(error);
    }

    // return that object
    return db_state;
} 

// post message to slack
const postMessage = async (opt, msg, channel) => {
    try{
        const response = await fetch(opt.url, {
            method:     opt.method,
            mode:       'cors',
            cache:      'no-cache',
            headers:    opt.headers,
            body:       JSON.stringify({
                "channel":  channel,
                "text":     msg
            })
        })
        // if our response is not http 200-299
        if(!response.ok){
            // throw an error saying this method failed.
            throw new Error("postMessage(): The request failed.")
        }
        // log the response from slack
        console.log(await response.json());
    }
    catch(error){
        console.error(error);
    }
}

// options for slack fetch
const slack_options = {
    method: 'POST',
    url: 'https://slack.com/api/chat.postMessage',
    headers: {
        'Authorization': 'Bearer '+process.env.SLACK_TOKEN,
        'Content-Type': 'application/json; charset=utf-8'
    },
    json: true
}

// options for tsheets fetch
const tsheets_options = { 
    method: 'POST',
    url:    'https://rest.tsheets.com/api/v1/reports/current_totals',
    headers:{
        'Authorization': 'Bearer '+process.env.TSHEETS_TOKEN,
        'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify({
        "data":{
            "group_ids": process.env.TECH_GROUPS,
            "on_the_clock": "both"
        }
    }),
    json: true 
};


// main execution method
const main = async (slack_opt, tsheets_opt) => {

    // create the database connection
    const connection = mysql.createConnection({
        host:       process.env.DB_HOST,
        user:       process.env.DB_USER,
        password:   process.env.DB_PASS,
        database:   process.env.DB_NAME
    });

    // get api state
    const api_state =   await getApiState(tsheets_opt);
    
    // get db state
    const db_state =    await getDbState(connection);

    // initialize update statement
    let query = "";
    
    // iterate over api state and compare with db state
    for(k in api_state){
        user = api_state[k]

        // move on to the next iteration if there is no
        // change on this user id
        if(user.state == db_state[user.user_id]) continue;

        // initialize the clock status as "off the clock"
        let clockstatus = "off the clock.";
        if(user.state){
            // if the user is clocked in, change the status
            clockstatus = "on the clock."
            // if the jobcode_id value exists at all
            if(user.jobcode_id){
                // it means the user is on a meal break
                clockstatus = "on a meal break."
            }
        }
        // build the message for slack with name and clock status
        let msg = user.name+" is now " + clockstatus;
        // add this dataset to the update query string
        query += "('" + user.user_id + "', '" + clockstatus + "'), ";
        // post a message to the test slack channel
        postMessage(slack_opt, msg, "testforalex");
        // post a message to the real slack channel
        // postMessage(slack_opt, msg, user.chan);
        
        // log our output
        console.log(msg);
        console.log(user.channel);
    }

    // trim the final comma and space from our query string
    query = query.substring(0, query.length - 2);

    // if the query string exists
    if(query){
        query = "REPLACE INTO state (user_id, state) VALUES " + query;
        console.log(query);
        // update the database
        (await connection).query(query);
    }

    // log the timestamp just for easier debugging
    console.log(new Date(Date.now()));

    // close the database connection
    (await connection).end();
}

// run main once at execution start
main(slack_options, tsheets_options);

// and again every 30 seconds after that
setInterval(() => {
    main(slack_options, tsheets_options)
}, 30000);