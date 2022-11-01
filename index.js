const iridium = require('./iridium');

const initialize = async () => {
    const numberOfSatMessages = 5;

    const signalStrength = await iridium.getSignalStrength();
    console.log('Iridium signal strength: ', signalStrength);

    for(let i = 0; i < numberOfSatMessages; i++) {
        iridium.send(`Hello_Earth_${i + 1}`).then((res)=>{
            console.log('[OK] Send message', res);
        }).catch((err)=>{
            console.log('[ERROR] Send message', err);
        });
    }

    // listen for incoming messages
    iridium.sbd.on('message', (message)=>{
        console.log('Received:', message);
    });
}

initialize();