var path       = require("path"),
    util       = require("util"),
    iwlist     = require("./iwlist"),
    express    = require("express"),
    bodyParser = require('body-parser'),
    config     = require("../config.json"),
    http_test  = config.http_test_only,
    exec       = require("child_process").exec,
    timer_delay      = 300000;

// Helper function to log errors and send a generic status "SUCCESS"
// message to the caller
function log_error_send_success_with(success_obj, error, response) {
    if (error) {
        console.log("ERROR: " + error);
        response.send({ status: "ERROR", error: error });
    } else {
        success_obj = success_obj || {};
        success_obj["status"] = "SUCCESS";
        response.send(success_obj);
    }
    response.end();
}

/*****************************************************************************\
    Returns a function which sets up the app and our various routes.
\*****************************************************************************/
module.exports = function(wifi_manager, callback) {
    var app = express();

    // Configure the app
    app.set("view engine", "ejs");
    app.set("views", path.join(__dirname, "views"));
    app.set("trust proxy", true);

    // Setup static routes to public assets
    app.use(express.static(path.join(__dirname, "public")));
    app.use(bodyParser.json());

    // Setup HTTP routes for rendering views
    app.get("/", function(request, response) {
        response.render("index");
	
	clearTimeout(timeout);
	timeout_server(timer_delay);
    });

    // Get mac address
    app.get("/api/get_ssid", function(request, response) {
	console.log("server got /get_ssid");

	clearTimeout(timeout);
	timeout_server(timer_delay);
		
	var ssid = {
		ssid: config.access_point.ssid
	}
	
	response.send(ssid);
	response.end();
    });

    // Setup HTTP routes for various APIs we wish to implement
    // the responses to these are typically JSON
    app.get("/api/rescan_wifi", function(request, response) {
        console.log("Server got /rescan_wifi");

	clearTimeout(timeout);
    	timeout_server(timer_delay);

        iwlist(function(error, result) {
            log_error_send_success_with(result[0], error, response);
        });
    });

    app.post("/api/enable_wifi", function(request, response) {
	response.end();

	clearTimeout(timeout);
	timeout_server(timer_delay);

        var conn_info = {
            wifi_ssid:      request.body.wifi_ssid,
            wifi_passcode:  request.body.wifi_passcode,
        };

        // TODO: If wifi did not come up correctly, it should fail
        // currently we ignore ifup failures.
        wifi_manager.set_wifi_mode(conn_info, function(error) {
            if (error) {
                console.log("Enable Wifi ERROR: " + error);
		wifi_manager.empty_wpa_supplicant(function() {
			
			//if ifup fails, we need to reboot the interface
			//after clearing wpa_supplicant before we can
			//enable AP mode, otherwise ifup will tell us
			//that the interface is already configured
			if (error.indexOf("Failed to bring up " + config.wifi_interface) > -1) {
				console.log("Rebooting interface...");
				wifi_manager.reboot_wireless_network(config.wifi_interface, function(error) {
					if (error) { console.log(error); };

					console.log("Attempt to re-enable AP mode");
                			wifi_manager.enable_ap_mode(config.access_point.ssid, function(error) {
                    				console.log("... AP mode reset");
                			});
		    		});
			} else {
                		console.log("Attempt to re-enable AP mode");
                		wifi_manager.enable_ap_mode(config.access_point.ssid, function(error) {
                    			console.log("... AP mode reset");
                		});
			};
		});
		response.end();
            } else {
		// Success! - exit
		console.log("Wifi enabled! - Exiting");
		process.exit(0);    
	    }
            
        });
    });

    // Listen on our server
    server = app.listen(config.server.port, timeout_server(120000)); //2 min 
    
    function timeout_server(delay) {
        timeout = setTimeout(function() {
	    console.log("Timeout limit reached...");
	    wifi_manager.previous_networks(function(error, previous_networks) {
	        if(previous_networks) {
		    console.log("Previous networks found...");
		    server.close(function() {
			wifi_manager.enable_wifi_mode(function(error) {
			    if (error) {
				console.log("Wifi mode could not be enabled");
			    } else {
				console.log("Wifi mode enabled - sucess!");
			    };
			    /*wifi_manager.is_wifi_enabled(function(error, result_ip) {
			        if(result_ip) {
				    console.log("Wifi mode enabled - success!");
				} else {
				    console.log("Wifi mode could not be enabled");
				    
				    //TODO: re-enable AP mode and restart server?
				    //This may not be necessary as the script
				    //reruns in the next minute
				};
			    });*/
			});
		    });
		    console.log("Closing server - waiting on connections to close.");
		} else {
		    console.log("No previous networks - cancelling timer");
		};
	    });
    	}, delay);
   };
};
