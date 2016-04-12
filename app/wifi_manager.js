var _       = require("underscore")._,
    async   = require("async"),
    fs      = require("fs"),
    exec    = require("child_process").exec,
    config  = require("../config.json");

// Better template format
_.templateSettings = {
    interpolate: /\{\{(.+?)\}\}/g,
    evaluate :   /\{\[([\s\S]+?)\]\}/g
};

// Helper function to write a given template to a file based on a given
// context
function write_template_to_file(template_path, file_name, context, callback) {
    async.waterfall([

        function read_template_file(next_step) {
            fs.readFile(template_path, {encoding: "utf8"}, next_step);
        },

        function update_file(file_txt, next_step) {
            var template = _.template(file_txt);
            fs.writeFile(file_name, template(context), next_step);
        }

    ], callback);
}

/*****************************************************************************\
    Return a set of functions which we can use to manage and check our wifi
    connection information
\*****************************************************************************/
module.exports = function() {
    // Detect which wifi driver we should use, the rtl871xdrv or the nl80211
    exec("iw list", function(error, stdout, stderr) {
        if (stderr.match(/^nl80211 not found/)) {
            config.wifi_driver_type = "rtl871xdrv";
        }
        // console.log("config.wifi_driver_type = " + config.wifi_driver_type);
    });

    // Hack: this just assumes that the outbound interface will be "wlan0"

    // Define some globals
    var ifconfig_fields = {
        "hw_addr":         /HWaddr\s([^\s]+)/,
        "inet_addr":       /inet addr:([^\s]+)/,
    },  iwconfig_fields = {
        "ap_addr":         /Access Point:\s([^\s]+)/,
        "ap_ssid":         /ESSID:\"([^\"]+)\"/,
        "unassociated":    /(unassociated)\s+Nick/,
	"mode":		   /Mode:([^\s]+)/,
    },  last_wifi_info = null;

    // TODO: rpi-config-ap hardcoded, should derive from a constant

    // Get generic info on an interface
    var _get_wifi_info = function(callback) {
        var output = {
            hw_addr:      "<unknown>",
            inet_addr:    "<unknown>",
            unassociated: "<unknown>",
	    ap_ssid: 	  "<unknown",
        };

        // Inner function which runs a given command and sets a bunch
        // of fields
        function run_command_and_set_fields(cmd, fields, callback) {
            exec(cmd, function(error, stdout, stderr) {
                if (error) return callback(error);
                for (var key in fields) {
                    re = stdout.match(fields[key]);
                    if (re && re.length > 1) {
                        output[key] = re[1];
                    }
                }
                callback(null);
            });
        }

        // Run a bunch of commands and aggregate info
        async.series([
            function run_ifconfig(next_step) {
                run_command_and_set_fields("ifconfig wlan0", ifconfig_fields, next_step);
            },
            function run_iwconfig(next_step) {
                run_command_and_set_fields("iwconfig wlan0", iwconfig_fields, next_step);
            },
        ], function(error) {
            last_wifi_info = output;
            return callback(error, output);
        });
    },

    _reboot_wireless_network = function(wlan_iface, callback) {
        async.series([
            function down(next_step) {
                exec("sudo ifdown " + wlan_iface, function(error, stdout, stderr) {
                    if (!error ) console.log("ifdown " + wlan_iface + " successful...");
		    next_step();
                });
            },
            function up(next_step) {
                exec("sudo ifup " + wlan_iface, function(error, stdout, stderr) {
                    if (error) {
			console.log(error);
		    } else if (stdout.indexOf("Failed to bring up " + wlan_iface) > -1) {
			return callback(stdout);
		    } else {
		   	console.log("ifup " + wlan_iface + " successful...");
			next_step();
		    } 
                });
            },
        ], callback);
    },

    // Wifi related functions
    _is_wifi_enabled_sync = function(info) {
	// If we are not an AP, and we have a valid
        // inet_addr - wifi is enabled!
        if (null        == _is_ap_enabled_sync(info) &&
            "<unknown>" != info["inet_addr"]         &&
	    "<unknown" != info["ap_ssid"]	     &&
            "<unknown>" == info["unassociated"] ) {
		return info["inet_addr"];
        }
        return null;
    },

    _is_wifi_enabled = function(callback) {
        _get_wifi_info(function(error, info) {
            if (error) return callback(error, null);
            return callback(null, _is_wifi_enabled_sync(info));
        });
    },

    // Access Point related functions
    _is_ap_enabled_sync = function(info) {
        return (info["mode"] == "Master") ? info["hw_addr"] : null; 
    },

    _is_ap_enabled = function(callback) {
        _get_wifi_info(function(error, info) {
            if (error) return callback(error, null);
            return callback(null, _is_ap_enabled_sync(info));
        });
    },

    // Enables the accesspoint w/ bcast_ssid. This assumes that both
    // isc-dhcp-server and hostapd are installed using:
    // $sudo npm run-script provision
    _enable_ap_mode = function(bcast_ssid, callback) {
        _is_ap_enabled(function(error, result_addr) {
            if (error) {
                console.log("ERROR: " + error);
                return callback(error);
            }

            if (result_addr && !config.access_point.force_reconfigure) {
                console.log("\nAccess point is enabled with ADDR: " + result_addr);
                return callback(null);
            } else if (config.access_point.force_reconfigure) {
                console.log("\nForce reconfigure enabled - reset AP");
            } else {
                console.log("\nAP is not enabled yet... enabling...");
            }

            var context = config.access_point;
            context["enable_ap"] = true;
            context["wifi_driver_type"] = config.wifi_driver_type;

            // Here we need to actually follow the steps to enable the ap
            async.series([

                // Enable the access point ip and netmask + static
                // DHCP for the wlan0 interface
                function update_interfaces(next_step) {
                    write_template_to_file(
                        "./assets/etc/network/interfaces.ap.template",
                        "/etc/network/interfaces",
                        context, next_step);
                },

                // Enable DHCP conf, set authoritative mode and subnet
                function update_dhcpd(next_step) {
                    var context = config.access_point;
                    // We must enable this to turn on the access point
                    write_template_to_file(
                        "./assets/etc/dhcp/dhcpd.conf.template",
                        "/etc/dhcp/dhcpd.conf",
                        context, next_step);
                },

                // Enable the interface in the dhcp server
                function update_dhcp_interface(next_step) {
                    write_template_to_file(
                        "./assets/etc/default/isc-dhcp-server.template",
                        "/etc/default/isc-dhcp-server",
                        context, next_step);
                },

                // Enable hostapd.conf file
                function update_hostapd_conf(next_step) {
                    write_template_to_file(
                        "./assets/etc/hostapd/hostapd.conf.template",
                        "/etc/hostapd/hostapd.conf",
                        context, next_step);
                },

                function update_hostapd_default(next_step) {
                    write_template_to_file(
                        "./assets/etc/default/hostapd.template",
                        "/etc/default/hostapd",
                        context, next_step);
                },

                function reboot_network_interfaces(next_step) {
                    _reboot_wireless_network(context.wifi_interface, next_step);
                },

                function restart_dhcp_service(next_step) {
                    exec("service isc-dhcp-server restart", function(error, stdout, stderr) {
                        //console.log(stdout);
                        if (!error) console.log("... dhcp server restarted!");
                        next_step();
                    });
                },

                function restart_hostapd_service(next_step) {
                    exec("service hostapd restart", function(error, stdout, stderr) {
                        //console.log(stdout);
                        if (!error) console.log("... hostapd restarted!");
                        next_step();
                    });
                },

                // TODO: Do we need to issue a reboot here?

            ], callback);
        });
    },

    // Disables AP mode and reverts to wifi connection
    _set_wifi_mode = function(connection_info, callback) {

        _is_wifi_enabled(function(error, result_ip) {
            if (error) return callback(error);
	
            if (result_ip) {
                console.log("\nWifi connection is enabled with IP: " + result_ip);
                return callback(null);
            }
            
            console.log("enabling wifi mode...");

	    var context = config.access_point;

            async.series([

		// Update wpa_supplicant with correct info
		function update_wpa_supplicant(next_step) {
		    console.log("writing to wpa_supplicant...");
		    write_template_to_file(
                        "./assets/etc/wpa_supplicant/wpa_supplicant.conf.wifi.template",
                        "/etc/wpa_supplicant/wpa_supplicant.conf",
                        connection_info, next_step);
		},
		
		function enable_wifi(next_step) {
			_enable_wifi_mode(next_step);
		},
	    

            ], callback);
		
        });

    };

    _enable_wifi_mode = function(callback) {
	var context = config.access_point;

	async.series([

                // Update /etc/network/interface with correct info...
                function update_interfaces(next_step) {
	            console.log("writing to template...");
		    write_template_to_file(
                        "./assets/etc/network/interfaces.template",
                        "/etc/network/interfaces", context, next_step);
                },

                // Stop the DHCP server...
                function restart_dhcp_service(next_step) {
                    exec("service isc-dhcp-server stop", function(error, stdout, stderr) {
                        if (!error) console.log("... dhcp server stopped!")	;
			next_step();
                    });
                },

                function reboot_network_interfaces(next_step) {
                    _reboot_wireless_network(config.wifi_interface, function(error) {
			if (error) { 
				return callback(error); 
			} else {	next_step();	};
		    }); 
                },
	    
		function test_connection(next_step) {
		    _is_wifi_enabled(function(error, result_ip) {
		    	if (result_ip == null) {
				return callback("Wifi is not enabled.");
			} else {
				next_step();
			};
		    });	
		},

            ], callback);
    };

    //Check to see if the Droplet has any previously known networks
    _previous_networks = function(callback) {
	fs.readFile("/etc/wpa_supplicant/wpa_supplicant.conf", {encoding: "utf8"}, function(error, data) {
		if (error) {
			console.log("Error reading file at /etc/wpa_supplicant/wpa_supplicant.conf");
			return callback(error, false);
		} else {
			network_available = data.match(/ssid/g);
			if (network_available) {
				return callback(null, true);
			} else {
				return callback(null, false);
			};	
		};
	});
    };

    //Set the SSID for the RPI as DROPLETXXX where XXX is the MAC address
    _set_ssid = function(callback) {
	exec("ifconfig eth0", function(error, stdout, stderr) {
		if (error) {
			return callback("Could not successfully execute ifconfig eth0");
		};
		
		var values = stdout.match(/HWaddr\s([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})/g);
		if (values) {
			//Format the MAC address
			var HWaddr = values[0].slice(7);
			HWaddr = HWaddr.replace(/:/g, "");
		
			//set ssid in config.json
			config.access_point.ssid = "Droplet" + HWaddr;
			fs.writeFileSync("config.json", JSON.stringify(config));
			
			return callback(null);
		} else {
			return callback("HWaddr of eth0 not found");
		};
	});
    };

    //Empty wpa file of all known networks
    _empty_wpa_supplicant = function(callback) {
	var context = "";
	
	console.log("Writing to wpa_supplicant.conf");
	write_template_to_file(
        	"./assets/etc/wpa_supplicant/wpa_supplicant.conf.empty.template",
                "/etc/wpa_supplicant/wpa_supplicant.conf",
                context, callback);
    };

    return {
        get_wifi_info:           _get_wifi_info,
        reboot_wireless_network: _reboot_wireless_network,

        is_wifi_enabled:         _is_wifi_enabled,
        is_wifi_enabled_sync:    _is_wifi_enabled_sync,

        is_ap_enabled:           _is_ap_enabled,
        is_ap_enabled_sync:      _is_ap_enabled_sync,

        enable_ap_mode:          _enable_ap_mode,
	set_wifi_mode:           _set_wifi_mode,
        enable_wifi_mode:        _enable_wifi_mode,
 
	previous_networks:	 _previous_networks,
	set_ssid:		 _set_ssid,
	empty_wpa_supplicant: 	 _empty_wpa_supplicant,
    };
}
